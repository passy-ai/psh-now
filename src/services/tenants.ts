import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, auditLog, devices, prompts, sessions, tenants, type Tenant } from "../db/schema";
import { generateApiKey, sha256 } from "../lib/crypto";
import { forget, memo } from "../lib/memo";
import { decryptSecret, encryptSecret } from "../lib/secrets";
import { env } from "../env";

export type KeyScope = "ask" | "approve" | "manage";

export interface CreatedTenant {
  tenant: Tenant;
  /** Raw account key (scope `approve`), shown to the caller exactly once. */
  apiKey: string;
  /**
   * Raw account SECRET key (scope `manage`). Minted with the account so every
   * account can pair devices and administer itself from the first minute.
   * Deliberately NOT returned by the install/mint responses, the owner reads
   * it from the dashboard (`/api/v1/me/secret/reveal`), so it never lands in an
   * agent's terminal output.
   */
  secretKey: string;
}

/** Create a new isolated workspace/channel and return its one-time API key. */
export async function createTenant(name?: string): Promise<CreatedTenant> {
  const { key, hash, prefix } = generateApiKey("user");
  // The SECRET key is minted here too: pairing a device and administering the
  // account both need `manage` scope, and a brand-new account has no way to
  // create one. It is stored hashed + encrypted and only ever revealed to the
  // signed-in dashboard, never through `/mint` or an install report.
  const secret = generateApiKey("admin");
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: name?.trim() || "Untitled workspace",
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      // Keep an encrypted copy so email + password sign-in can return the key.
      apiKeyEnc: await encryptSecret(key),
      secretKeyHash: secret.hash,
      secretKeyPrefix: secret.prefix,
      secretKeyEnc: await encryptSecret(secret.key),
      plan: "anonymous",
      expiresAt: null,
    })
    .returning();

  if (!tenant) throw new Error("Failed to create tenant");
  return { tenant, apiKey: key, secretKey: secret.key };
}

/**
 * Create the account SECRET key (manage scope) once. Returns the raw key, or
 * `null` if one already exists. Shown exactly once.
 */
export async function createSecretKey(
  tenantId: string,
): Promise<string | null> {
  const [existing] = await db
    .select({ hash: tenants.secretKeyHash })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!existing || existing.hash) return null;

  const secret = generateApiKey("admin");
  await db
    .update(tenants)
    .set({
      secretKeyHash: secret.hash,
      secretKeyPrefix: secret.prefix,
      // Keep an encrypted copy so the owner can copy it again later.
      secretKeyEnc: await encryptSecret(secret.key),
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId));
  return secret.key;
}

/** Decrypt the stored secret key so the owner can copy it again. */
export async function revealSecretKey(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ enc: tenants.secretKeyEnc })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row?.enc) return null;
  return decryptSecret(row.enc);
}

/** Attach an email + name to a workspace and make it permanent (free plan). */
export async function claimTenant(
  tenantId: string,
  email: string,
  name?: { firstName?: string | null; lastName?: string | null },
): Promise<Tenant | null> {
  const [tenant] = await db
    .update(tenants)
    .set({
      email,
      firstName: name?.firstName ?? null,
      lastName: name?.lastName ?? null,
      claimedAt: new Date(),
      expiresAt: null,
      plan: "free",
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
    .returning();
  return tenant ?? null;
}

/** Delete unclaimed workspaces whose expiry has passed. Returns how many. */
export async function sweepExpiredTenants(): Promise<number> {
  const removed = await db
    .delete(tenants)
    .where(and(isNull(tenants.claimedAt), lt(tenants.expiresAt, new Date())))
    .returning({ id: tenants.id });
  return removed.length;
}

/**
 * Add a prepaid token package. **The plan does not move**: prepaid requests sit
 * *beside* the free allowance, so a workspace that has bought credits still
 * reads Free (owner, 2026-10-15: *"My status says token but it should always
 * remain free"*). The balance is a meter, not a plan, and `checkLimit()` already
 * spends it once the free rack is empty.
 */
/**
 * Requests this workspace was already given for nothing while no payment provider was
 * live. Derived from the audit log, so the grant and the record of it cannot disagree.
 */
export async function directGrantsUsed(tenantId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum((${auditLog.detail}->>'requests')::int), 0)`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "tokens.direct")));
  return Number(row?.total ?? 0);
}

export async function addTokens(
  tenantId: string,
  count: number,
): Promise<number> {
  const [row] = await db
    .update(tenants)
    .set({
      tokenBalance: sql`${tenants.tokenBalance} + ${count}`,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
    .returning({ balance: tenants.tokenBalance });
  /**
   * The dashboard refetches itself the moment the balance changes, and a cached key
   * lookup would hand it the number from before the grant - the meter not moving is
   * indistinguishable from the purchase having failed.
   */
  forget("keyauth:");
  return row?.balance ?? 0;
}

/**
 * Grant the one-per-account free entry pack. The stamp and the grant are a single
 * statement conditional on the stamp still being null, so a double click cannot take
 * it twice and there is no read-then-write window to lose a race in.
 */
export async function claimFreePack(
  tenantId: string,
  count: number,
): Promise<{ claimed: boolean; balance: number }> {
  const [row] = await db
    .update(tenants)
    .set({
      tokenBalance: sql`${tenants.tokenBalance} + ${count}`,
      freePackAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(tenants.id, tenantId), isNull(tenants.freePackAt)))
    .returning({ balance: tenants.tokenBalance });
  if (row) return { claimed: true, balance: row.balance };
  const [current] = await db
    .select({ balance: tenants.tokenBalance })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return { claimed: false, balance: current?.balance ?? 0 };
}

/** Spend tokens. Returns the remaining balance (or unchanged if none left). */
export async function consumeTokens(
  tenantId: string,
  count = 1,
): Promise<number> {
  const [row] = await db
    .update(tenants)
    .set({ tokenBalance: sql`greatest(0, ${tenants.tokenBalance} - ${count})` })
    .where(and(eq(tenants.id, tenantId), gt(tenants.tokenBalance, 0)))
    .returning({ balance: tenants.tokenBalance });
  return row?.balance ?? 0;
}

/**
 * Look up a tenant from a raw API key. Checks the extra agent keys first,
 * then the workspace's original key column (kept for backwards compatibility).
 */
export async function findTenantByApiKey(rawKey: string): Promise<Tenant | null> {
  const auth = await findKeyAuth(rawKey);
  return auth?.tenant ?? null;
}

export type AdoptFailure =
  | "not-found"
  | "same-account"
  | "claimed"
  | "not-anonymous"
  | "too-old"
  | "has-devices"
  | "too-busy"
  | "no-agent-key";

export type AdoptResult =
  | { ok: true; workspaceId: string; channels: number; channelsMoved: number; requestsMoved: number }
  | { ok: false; reason: AdoptFailure };

/** A workspace is only adoptable while it is still obviously a fresh install. */
const ADOPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADOPT_MAX_REQUESTS = 5;

/**
 * Take a freshly minted anonymous workspace into an existing account.
 *
 * A new project's install mints its own anonymous workspace, so an agent in a
 * second project ends up asking from an account the human cannot see. When that
 * human (already signed in) opens the link, this moves the agent's channel
 * and its pending requests into their account: the agent keeps its channel key
 * and its questions start arriving in the dashboard they already use.
 *
 * Only the agent's `ask`-scoped key travels. Its account (approve) key, join
 * links, devices and audit trail stay behind and die with the workspace, so an
 * agent can never approve its own requests in the owner's account. Anything
 * that is claimed, paired, older than a day or already busy is refused rather
 * than absorbed, so a stray link cannot swallow a real account.
 */
export async function adoptWorkspace(ownerId: string, offeredKey: string): Promise<AdoptResult> {
  const offered = await findTenantByApiKey(offeredKey);
  if (!offered) return { ok: false, reason: "not-found" };
  if (offered.id === ownerId) return { ok: false, reason: "same-account" };
  if (offered.claimedAt || offered.email) return { ok: false, reason: "claimed" };
  if (offered.plan !== "anonymous") return { ok: false, reason: "not-anonymous" };
  if (Date.now() - offered.createdAt.getTime() > ADOPT_MAX_AGE_MS) {
    return { ok: false, reason: "too-old" };
  }

  const [paired] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(devices)
    .where(eq(devices.tenantId, offered.id));
  if ((paired?.n ?? 0) > 0) return { ok: false, reason: "has-devices" };

  const [busy] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(prompts)
    .where(eq(prompts.tenantId, offered.id));
  if ((busy?.n ?? 0) > ADOPT_MAX_REQUESTS) return { ok: false, reason: "too-busy" };

  try {
    return await db.transaction(async (tx) => {
      const movedKeys = await tx
        .update(apiKeys)
        .set({ tenantId: ownerId })
        .where(and(eq(apiKeys.tenantId, offered.id), eq(apiKeys.scope, "ask")))
        .returning({ id: apiKeys.id });
      if (movedKeys.length === 0) throw new Error("no-agent-key");

      await tx.update(sessions).set({ tenantId: ownerId }).where(eq(sessions.tenantId, offered.id));
      const movedPrompts = await tx
        .update(prompts)
        .set({ tenantId: ownerId })
        .where(eq(prompts.tenantId, offered.id))
        .returning({ id: prompts.id });

      // Everything else (account key, join links, audit rows) cascades away.
      await tx.delete(tenants).where(eq(tenants.id, offered.id));

      return {
        ok: true as const,
        workspaceId: offered.id,
        channels: movedKeys.length,
        channelsMoved: movedKeys.length,
        requestsMoved: movedPrompts.length,
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message === "no-agent-key") {
      return { ok: false, reason: "no-agent-key" };
    }
    throw err;
  }
}

/**
 * Resolve a raw key to its tenant and scope. `api_keys` rows carry a scope
 * (`ask` by default); the tenant's own key (apiKeyHash) is always `manage`.
 */
export async function findKeyAuth(rawKey: string): Promise<KeyAuth | null> {
  const hash = sha256(rawKey);
  // One page load asks for the same key five times; this makes that one round trip.
  return memo(`keyauth:${hash}`, 2_000, () => resolveKeyAuth(hash));
}

export interface KeyAuth {
  tenant: Tenant;
  scope: KeyScope;
  sessionId: string | null;
  keyId: string | null;
}

async function resolveKeyAuth(hash: string): Promise<KeyAuth | null> {

  const [key] = await db
    .select({
      id: apiKeys.id,
      tenantId: apiKeys.tenantId,
      scope: apiKeys.scope,
      sessionId: apiKeys.sessionId,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (key) {
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {});
    const tenant = await getTenant(key.tenantId);
    if (!tenant) return null;
    return {
      tenant,
      scope: key.scope === "manage" ? "manage" : "ask",
      sessionId: key.sessionId ?? null,
      keyId: key.id,
    };
  }

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.apiKeyHash, hash))
    .limit(1);
  if (tenant) {
    // The account key approves and reads; it can never administer the account.
    return { tenant, scope: "approve", sessionId: null, keyId: null };
  }

  const [bySecret] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.secretKeyHash, hash))
    .limit(1);
  return bySecret ? { tenant: bySecret, scope: "manage", sessionId: null, keyId: null } : null;
}

/**
 * Mint a fresh account key + secret for a tenant, invalidating the old ones.
 * The recovery path when an account key leaks.
 */
export async function rotateTenantKeys(
  tenantId: string,
): Promise<{ apiKey: string; secretKey: string } | null> {
  const { key, hash, prefix } = generateApiKey("user");
  const secret = generateApiKey("admin");
  const [tenant] = await db
    .update(tenants)
    .set({
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      apiKeyEnc: await encryptSecret(key),
      secretKeyHash: secret.hash,
      secretKeyPrefix: secret.prefix,
      secretKeyEnc: await encryptSecret(secret.key),
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
    .returning();
  if (!tenant) return null;
  return { apiKey: key, secretKey: secret.key };
}

/** Decrypt the stored account key (null when it was never captured). */
export async function revealAccountKey(tenant: Tenant): Promise<string | null> {
  if (!tenant.apiKeyEnc) return null;
  return decryptSecret(tenant.apiKeyEnc);
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, id))
    .limit(1);
  return tenant ?? null;
}

/** Find a registered account by its (lowercased) email. */
export async function findTenantByEmail(email: string): Promise<Tenant | null> {
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.email, email.trim().toLowerCase()))
    .limit(1);
  return tenant ?? null;
}

/**
 * Why was this key rejected? Returns a short, loggable reason. Used so a dead
 * key can be diagnosed from the server log instead of guessed at:
 *   - "revoked"            the key row exists but was revoked
 *   - "tenant missing"     the workspace was deleted (cascade removed the key)
 *   - "no matching row"    the key was never issued here / DB was reset
 */
export async function explainKeyRejection(rawKey: string): Promise<string> {
  const hash = sha256(rawKey);
  const [keyRow] = await db
    .select({ tenantId: apiKeys.tenantId, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (keyRow) {
    if (keyRow.revokedAt) return `revoked at ${keyRow.revokedAt.toISOString()}`;
    const tenant = await getTenant(keyRow.tenantId);
    return tenant
      ? "row + tenant both present (scope/session mismatch?)"
      : `tenant ${keyRow.tenantId} missing, workspace was deleted`;
  }
  const [acct] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.apiKeyHash, hash))
    .limit(1);
  if (acct) return "account key row present (unexpected)";
  const [secret] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.secretKeyHash, hash))
    .limit(1);
  if (secret) return "secret key row present (unexpected)";
  return "no matching row, key not issued here (workspace/DB was removed)";
}

/** Update the public profile bio + link. */
export async function updateProfile(
  tenantId: string,
  input: { bio?: string | null; link?: string | null },
): Promise<Tenant | null> {
  const [tenant] = await db
    .update(tenants)
    .set({
      bio: input.bio === undefined ? undefined : input.bio?.trim().slice(0, 160) || null,
      link: input.link === undefined ? undefined : input.link?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
    .returning();
  return tenant ?? null;
}
