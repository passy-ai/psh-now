import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  devices,
  pairingTokens,
  type Device,
} from "../db/schema";
import { sha256 } from "../lib/crypto";
import { newDeviceToken, newPairingToken } from "../lib/ids";
import { env } from "../env";

export interface CreatedPairing {
  /** Raw token embedded in the QR / pairing URL. Shown once. */
  token: string;
  url: string;
  expiresAt: Date;
}

/** Issue a short-lived pairing token + QR URL for a tenant. */
export async function createPairing(tenantId: string): Promise<CreatedPairing> {
  const token = newPairingToken();
  const expiresAt = new Date(Date.now() + env.pairingTtlMs);

  await db.insert(pairingTokens).values({
    tenantId,
    tokenHash: sha256(token),
    expiresAt,
  });

  return {
    token,
    url: `${env.publicBaseUrl}/pair/${token}`,
    expiresAt,
  };
}

export interface ConsumePairingInput {
  token: string;
  deviceName?: string;
  userAgent?: string | null;
  /** Where the device paired from — shown on the Devices page. */
  ip?: string | null;
  country?: string | null;
}

export interface PairedDevice {
  device: Device;
  /** Raw device token, stored by the phone and never recoverable later. */
  deviceToken: string;
}

/**
 * Redeem a pairing token. Idempotency is not provided: each token pairs exactly
 * one device. Returns null when the token is unknown, expired or already used.
 */
export async function consumePairing(
  input: ConsumePairingInput,
): Promise<PairedDevice | null> {
  const tokenHash = sha256(input.token);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(pairingTokens)
      .where(
        and(
          eq(pairingTokens.tokenHash, tokenHash),
          isNull(pairingTokens.consumedAt),
          gt(pairingTokens.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");

    if (!row) return null;

    const deviceToken = newDeviceToken();
    const [device] = await tx
      .insert(devices)
      .values({
        tenantId: row.tenantId,
        name: input.deviceName?.trim() || "Supervisor device",
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
        country: input.country ?? null,
        tokenHash: sha256(deviceToken),
      })
      .returning();

    if (!device) throw new Error("Failed to create device");

    await tx
      .update(pairingTokens)
      .set({ consumedAt: new Date() })
      .where(eq(pairingTokens.id, row.id));

    return { device, deviceToken };
  });
}

/** Resolve a device from its raw session token. */
export async function findDeviceByToken(rawToken: string): Promise<Device | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.tokenHash, sha256(rawToken)),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  return device ?? null;
}

/** Record liveness for a device (best-effort, never throws to callers). */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouch = new Map<string, number>();

export async function touchDevice(deviceId: string): Promise<void> {
  // One write a minute per device is plenty: `online` is a two-minute window, so a
  // finer heartbeat changes nothing. Writing on every inbound WebSocket frame put an
  // UPDATE of the same row behind every frame, and ten pooled connections all sat in
  // that queue — every other query (mint, sign-in, reads) waited behind a row lock on
  // one device while the database ran at 100% CPU doing nothing useful.
  const now = Date.now();
  const previous = lastTouch.get(deviceId);
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return;
  lastTouch.set(deviceId, now);

  try {
    await db
      .update(devices)
      .set({ lastSeenAt: new Date(now) })
      .where(
        and(
          eq(devices.id, deviceId),
          // This guard also holds across instances and restarts, where the map above
          // is empty; without it the first frame after a deploy would always write.
          or(
            isNull(devices.lastSeenAt),
            lt(devices.lastSeenAt, new Date(now - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
  } catch (err) {
    lastTouch.delete(deviceId);
    console.error("[devices] touch failed", err);
  }
}

export async function listDevices(tenantId: string): Promise<Device[]> {
  return db
    .select()
    .from(devices)
    .where(eq(devices.tenantId, tenantId))
    .orderBy(desc(devices.pairedAt));
}

export async function revokeDevice(
  tenantId: string,
  deviceId: string,
): Promise<boolean> {
  const result = await db
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.tenantId, tenantId)))
    .returning({ id: devices.id });
  return result.length > 0;
}

/** Rename a paired device (optional, cosmetic). */
export async function renameDevice(
  tenantId: string,
  deviceId: string,
  name: string,
): Promise<Device | null> {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return null;
  const [row] = await db
    .update(devices)
    .set({ name: trimmed })
    .where(and(eq(devices.id, deviceId), eq(devices.tenantId, tenantId)))
    .returning();
  return row ?? null;
}

export async function countActiveDevices(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.tenantId, tenantId), isNull(devices.revokedAt)));
  return row?.count ?? 0;
}
