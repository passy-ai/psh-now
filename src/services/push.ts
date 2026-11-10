import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { pushSubscriptions, settings } from "../db/schema";
import { env } from "../env";

/**
 * Real Web Push (VAPID), so alerts reach a **closed** tab or phone, not just
 * an open page. Works on Android/desktop/Firefox natively; on iOS the site must
 * be installed to the Home Screen first.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let cached: VapidKeys | null = null;

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** VAPID keys from env, else generated once and persisted in the database. */
export async function getVapid(): Promise<VapidKeys> {
  if (cached) return cached;

  let publicKey = env.vapidPublicKey || (await getSetting("vapid_public_key"));
  let privateKey = env.vapidPrivateKey || (await getSetting("vapid_private_key"));

  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    await setSetting("vapid_public_key", publicKey);
    await setSetting("vapid_private_key", privateKey);
    console.log("[push] generated and persisted VAPID keys");
  }

  const subject = env.vapidSubject;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  cached = { publicKey, privateKey, subject };
  return cached;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(
  tenantId: string,
  deviceId: string | null,
  sub: BrowserSubscription,
  userAgent: string | null,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      tenantId,
      deviceId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        tenantId,
        deviceId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        lastSeenAt: new Date(),
      },
    });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

export async function countSubscriptions(tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.tenantId, tenantId));
  return rows.length;
}

export interface PushPayload {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
  promptId?: string;
}

async function sendTo(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<boolean> {
  const vapid = await getVapid();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        TTL: 300,
      },
    );
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      // Subscription is gone; clean it up.
      await removeSubscription(sub.endpoint);
    } else {
      console.error("[push] send failed", status, (err as Error).message);
    }
    return false;
  }
}

/** Send a push to every subscription for a workspace. Returns how many sent. */
export async function sendPushToTenant(
  tenantId: string,
  payload: PushPayload,
): Promise<number> {
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.tenantId, tenantId));
  if (!subs.length) return 0;

  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      if (await sendTo(s, payload)) sent++;
    }),
  );
  return sent;
}
