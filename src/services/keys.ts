import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, type ApiKey } from "../db/schema";
import { forget } from "../lib/memo";
import { generateApiKey, sha256 } from "../lib/crypto";
import { decryptSecret, encryptSecret } from "../lib/secrets";

export interface CreatedApiKey {
  /** Raw key, shown to the caller exactly once. */
  key: string;
  record: ApiKey;
}

const AGENT_ADJECTIVES = [
  "amber", "bold", "calm", "deft", "eager", "fleet", "glad", "keen", "lucid",
  "mellow", "neat", "prime", "quick", "rapid", "sharp", "sleek", "swift", "tidy",
  "vivid", "warm",
];
const AGENT_NOUNS = [
  "otter", "falcon", "lark", "heron", "bison", "comet", "cedar", "delta", "ember",
  "finch", "grove", "harbor", "iris", "jasper", "kite", "lumen", "maple", "nimbus",
  "onyx", "quartz",
];

/** A friendly, memorable default so agents are distinguishable at a glance. */
export function randomAgentName(): string {
  const a = AGENT_ADJECTIVES[Math.floor(Math.random() * AGENT_ADJECTIVES.length)];
  const n = AGENT_NOUNS[Math.floor(Math.random() * AGENT_NOUNS.length)];
  return `${a}-${n}`;
}

/** Mint a new agent API key for a workspace. Only the hash is stored. */
export async function createApiKey(
  tenantId: string,
  name = randomAgentName(),
  opts: { scope?: "ask" | "manage"; sessionId?: string | null } = {},
): Promise<CreatedApiKey> {
  const { key, hash, prefix } = generateApiKey("agent");
  const [record] = await db
    .insert(apiKeys)
    .values({
      tenantId,
      name: name.trim() || "Agent key",
      scope: opts.scope ?? "ask",
      sessionId: opts.sessionId ?? null,
      keyHash: hash,
      keyEnc: await encryptSecret(key),
      prefix,
    })
    .returning();

  if (!record) throw new Error("Failed to create API key");
  return { key, record };
}

/** Agent keys bound to one channel. */
export async function listChannelKeys(
  tenantId: string,
  sessionId: string,
): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        eq(apiKeys.sessionId, sessionId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .orderBy(desc(apiKeys.createdAt));
}

/** How many live keys are bound to a channel. */
export async function countChannelKeys(
  tenantId: string,
  sessionId: string,
): Promise<number> {
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        eq(apiKeys.sessionId, sessionId),
        isNull(apiKeys.revokedAt),
      ),
    );
  return rows.length;
}

/**
 * Return the raw key for a workspace, if it was stored recoverably. Keys made
 * before reveal existed (or by the legacy path) return null.
 */
export async function revealApiKey(
  tenantId: string,
  id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ keyEnc: apiKeys.keyEnc })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.tenantId, tenantId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);

  if (!row?.keyEnc) return null;
  return decryptSecret(row.keyEnc);
}

export async function listApiKeys(tenantId: string): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.tenantId, tenantId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return result.length > 0;
}

/** Rename an agent key (optional, cosmetic). */
export async function renameApiKey(
  tenantId: string,
  id: string,
  name: string,
): Promise<ApiKey | null> {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return null;
  const [row] = await db
    .update(apiKeys)
    .set({ name: trimmed })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId)))
    .returning();
  return row ?? null;
}

/** What an MCP client called itself in the `initialize` handshake. */
export interface ClientIdentity {
  name: string | null;
  title: string | null;
  version: string | null;
}

const CLIENT_FIELD_MAX = 80;

/** Trim, cap and empty-to-null one handshake field. A client may send anything. */
function cleanClientField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters would end up in a list a human reads; strip them rather
  // than store whatever a misbehaving client put in the handshake.
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return trimmed ? trimmed.slice(0, CLIENT_FIELD_MAX) : null;
}

/**
 * Normalise `initialize`'s `params.clientInfo` into the columns we store.
 *
 * The spec shapes it as `{name, title?, version}`. Clients vary: older ones send
 * only `name`, some send `title`, and a few put the whole string in `name`. Every
 * field is optional, so a client that sends nothing yields all-null and we simply
 * record no identity - it must never reject a handshake the protocol accepts.
 */
export function parseClientInfo(raw: unknown): ClientIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const info = raw as Record<string, unknown>;
  const identity: ClientIdentity = {
    name: cleanClientField(info.name),
    title: cleanClientField(info.title),
    version: cleanClientField(info.version),
  };
  if (!identity.name && !identity.title && !identity.version) return null;
  return identity;
}

/** `dsh-mcp-client 0.0.1`, or just the name, or null when nothing was declared. */
export function clientLabel(key: Pick<ApiKey, "clientName" | "clientVersion">): string | null {
  if (!key.clientName) return null;
  return key.clientVersion ? `${key.clientName} ${key.clientVersion}` : key.clientName;
}

/**
 * The identity recorded for this raw key's most recent handshake, for naming a
 * request's `agent`. Null when the key is unknown or never handshook.
 */
export async function clientAgentForKey(rawKey: string): Promise<string | null> {
  const [row] = await db
    .select({ clientName: apiKeys.clientName, clientVersion: apiKeys.clientVersion })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256(rawKey)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return row ? clientLabel(row) : null;
}

/**
 * Record who this key's client says it is.
 *
 * Called from `initialize`, which carries no key of its own: the key is whatever
 * the same request's headers present. Unauthenticated callers and unknown keys are
 * silently ignored - an unauthenticated handshake is not an error, and this must
 * never be a way to write to somebody else's row.
 *
 * Best effort: a failure here must not fail a handshake. The identity is a label
 * for the human, not something the protocol depends on.
 */
export async function recordClientIdentity(
  rawKey: string | null,
  identity: ClientIdentity,
): Promise<void> {
  if (!rawKey) return;
  try {
    const hash = sha256(rawKey);
    await db
      .update(apiKeys)
      .set({
        clientName: identity.name,
        clientTitle: identity.title,
        clientVersion: identity.version,
        clientSeenAt: new Date(),
      })
      // Only refresh the timestamp when something actually changed, so a client
      // re-connecting in a loop does not rewrite this row on every handshake.
      .where(
        and(
          eq(apiKeys.keyHash, hash),
          isNull(apiKeys.revokedAt),
          sql`(
            ${apiKeys.clientName} is distinct from ${identity.name}
            or ${apiKeys.clientTitle} is distinct from ${identity.title}
            or ${apiKeys.clientVersion} is distinct from ${identity.version}
          )`,
        ),
      );
    // The keys list reads this straight back.
    forget("keyauth:");
  } catch {
    /* a handshake must not fail on a bookkeeping write */
  }
}

