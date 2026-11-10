import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, type ApiKey } from "../db/schema";
import { generateApiKey } from "../lib/crypto";
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
