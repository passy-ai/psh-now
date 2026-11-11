import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { channelShares, prompts, sessions, type Session } from "../db/schema";
import { gone } from "../lib/http";
import { newChannelUrl } from "../lib/ids";

/**
 * A session is one logical agent run/thread. A workspace key can drive many
 * sessions; the first request mints one and later requests can reuse its id.
 */

/** Accent colours assigned to new channels so they are easy to tell apart. */
const ACCENTS = ["#7c5cff", "#e0662b", "#2bb673", "#e0b02b", "#3b9dff", "#e04f8a"];

export async function createSession(
  tenantId: string,
  name?: string,
  agent?: string | null,
): Promise<Session> {
  const displayName = name?.trim() || "Unnamed connection";
  const [row] = await db
    .insert(sessions)
    .values({
      tenantId,
      name: displayName,
      // The public URL ending: 16 random characters, never derived from the name
      // and never changed afterwards. Connected agents keep working because the
      // link they were given stays valid for the life of the channel.
      slug: await freeChannelUrl(),
      color: ACCENTS[Math.floor(Math.random() * ACCENTS.length)] ?? null,
      agent: agent ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to create session");
  return row;
}

/**
 * A random, unused channel URL ending. Collisions are astronomically unlikely
 * (16 base62 characters); the loop is here so a freak one cannot fail a create.
 */
export async function freeChannelUrl(): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const candidate = newChannelUrl();
    if (!(await slugTaken(candidate))) return candidate;
  }
  return newChannelUrl();
}

export async function getSession(
  tenantId: string,
  id: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/** Fetch a channel by id regardless of owner (callers must check access). */
export async function getSessionById(id: string): Promise<Session | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return row ?? null;
}

/** Account ids a channel is shared with. */
export async function getChannelShareIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ sharedWith: channelShares.sharedWith })
    .from(channelShares)
    .where(eq(channelShares.channelId, channelId));
  return rows.map((r) => r.sharedWith);
}

export async function touchSession(id: string): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, id));
  } catch {
    /* liveness is best-effort */
  }
}

/** Find the given session, or mint a new one. */
/** The most-recently-used session with this name, if any. */
/** Fetch a channel by its public URL ending. */
export async function findSessionBySlug(
  tenantId: string,
  slug: string,
): Promise<Session | null> {
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.slug, trimmed)))
    .limit(1);
  return row ?? null;
}

/** Fetch a channel by name, ignoring case ("main" finds "Main"). */
export async function findSessionByNameLoose(
  tenantId: string,
  name: string,
): Promise<Session | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tenantId, tenantId), sql`lower(${sessions.name}) = lower(${trimmed})`),
    )
    .orderBy(desc(sessions.lastSeenAt))
    .limit(1);
  return row ?? null;
}

export async function findSessionByName(
  tenantId: string,
  name: string,
): Promise<Session | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.name, trimmed)))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(1);
  return row ?? null;
}

/** Rename a channel and/or set its description. */
export async function updateSession(
  tenantId: string,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    color?: string | null;
  },
): Promise<Session | null> {
  const nextName = input.name?.trim() || undefined;

  // `slug` is deliberately not updatable: a channel's public URL is minted once
  // and stays put. Sharing a link is how agents attach, so a URL that moved when
  // the channel was renamed (or edited by hand) silently orphaned them.
  const [row] = await db
    .update(sessions)
    .set({
      name: nextName,
      color: input.color === undefined ? undefined : input.color?.trim() || null,
      description:
        input.description === undefined
          ? undefined
          : input.description?.trim().slice(0, 400) || null,
    })
    .where(and(eq(sessions.id, id), eq(sessions.tenantId, tenantId)))
    .returning();
  return row ?? null;
}

/** Archive (hide) or restore a channel. */
export async function setSessionArchived(
  tenantId: string,
  id: string,
  archived: boolean,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(sessions.id, id), eq(sessions.tenantId, tenantId)))
    .returning();
  return row ?? null;
}

export async function resolveSession(
  tenantId: string,
  opts: {
    id?: string | null;
    name?: string | null;
    agent?: string | null;
    /**
     * Set when `id` was a *reference* the caller cannot invent, the channel a
     * key is bound to, or a handle-shaped string (channel id / URL ending). If
     * such a reference resolves to nothing, the request fails with this message
     * instead of falling through to the name/create path: silently creating a
     * replacement channel hides the fact that the agent's channel is gone.
     */
    unresolvedMessage?: string;
  },
): Promise<Session> {
  if (opts.id) {
    const existing = await getSession(tenantId, opts.id);
    if (existing) {
      void touchSession(existing.id);
      return existing;
    }
    // Agents address a channel by whatever string they were given: its id, its
    // URL ending, or the name from an older prompt. Accepting the last two keeps
    // a connected agent on its channel instead of quietly starting a new one.
    const byUrl = await findSessionBySlug(tenantId, opts.id);
    if (byUrl) {
      void touchSession(byUrl.id);
      return byUrl;
    }
    const byName = await findSessionByNameLoose(tenantId, opts.id);
    if (byName) {
      void touchSession(byName.id);
      return byName;
    }
    if (opts.unresolvedMessage) throw gone(opts.unresolvedMessage);
  }
  // Reuse a channel with the same name (ignoring case, like the id path above),
  // so "many agents → one channel" holds and repeated requests do not spawn
  // duplicate tabs just because two agents capitalised the project differently.
  if (opts.name) {
    const named = await findSessionByNameLoose(tenantId, opts.name);
    if (named) {
      void touchSession(named.id);
      return named;
    }
  }
  return createSession(tenantId, opts.name ?? undefined, opts.agent ?? null);
}

export interface SessionSummary extends Session {
  total: number;
  pending: number;
  /** True when this channel was shared with the caller by another account. */
  shared: boolean;
}

const SUMMARY_COLUMNS = {
  id: sessions.id,
  tenantId: sessions.tenantId,
  name: sessions.name,
  slug: sessions.slug,
  color: sessions.color,
  description: sessions.description,
  archivedAt: sessions.archivedAt,
  agent: sessions.agent,
  createdAt: sessions.createdAt,
  lastSeenAt: sessions.lastSeenAt,
  total: sql<number>`count(${prompts.id})::int`,
  pending: sql<number>`(count(*) filter (where ${prompts.status} = 'pending'))::int`,
};

/** Channels the account owns, plus any shared with it by another account. */
export async function listSessions(
  tenantId: string,
  limit = 50,
  /**
   * `archived` reads the other side of the same line: the channels the account put
   * away, newest first. Shares are never archived by the account that received one,
   * so there is nothing to add to them.
   */
  { archived = false }: { archived?: boolean } = {},
): Promise<SessionSummary[]> {
  const capped = Math.min(Math.max(limit, 1), 200);

  const owned = await db
    .select(SUMMARY_COLUMNS)
    .from(sessions)
    .leftJoin(prompts, eq(prompts.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.tenantId, tenantId),
        archived ? isNotNull(sessions.archivedAt) : isNull(sessions.archivedAt),
      ),
    )
    .groupBy(sessions.id)
    .orderBy(archived ? desc(sessions.archivedAt) : desc(sessions.lastSeenAt))
    .limit(capped);

  if (archived) return owned.map((s) => ({ ...s, shared: false }));

  const shared = await db
    .select(SUMMARY_COLUMNS)
    .from(sessions)
    .innerJoin(channelShares, eq(channelShares.channelId, sessions.id))
    .leftJoin(prompts, eq(prompts.sessionId, sessions.id))
    .where(eq(channelShares.sharedWith, tenantId))
    .groupBy(sessions.id)
    .orderBy(desc(sessions.lastSeenAt))
    .limit(capped);

  return [
    ...owned.map((s) => ({ ...s, shared: false })),
    ...shared.map((s) => ({ ...s, shared: true })),
  ];
}

/** True when the account owns the channel or it was shared with it. */
export async function canAccessChannel(
  tenantId: string,
  channelId: string,
): Promise<boolean> {
  const [channel] = await db
    .select({ tenantId: sessions.tenantId })
    .from(sessions)
    .where(eq(sessions.id, channelId))
    .limit(1);
  if (!channel) return false;
  if (channel.tenantId === tenantId) return true;

  const [share] = await db
    .select({ id: channelShares.id })
    .from(channelShares)
    .where(
      and(
        eq(channelShares.channelId, channelId),
        eq(channelShares.sharedWith, tenantId),
      ),
    )
    .limit(1);
  return !!share;
}

/** Tenant ids of every account a channel is shared with (the "watchers"). */
export async function sharedTenantIds(channelId: string): Promise<string[]> {
  const rows = await db
    .select({ tenantId: channelShares.sharedWith })
    .from(channelShares)
    .where(eq(channelShares.channelId, channelId));
  return rows.map((r) => r.tenantId);
}

/** Share a channel with another account id. Idempotent. */
export async function shareChannel(
  ownerId: string,
  channelId: string,
  sharedWith: string,
): Promise<boolean> {
  const [channel] = await db
    .select({ tenantId: sessions.tenantId })
    .from(sessions)
    .where(and(eq(sessions.id, channelId), eq(sessions.tenantId, ownerId)))
    .limit(1);
  if (!channel) return false;

  await db
    .insert(channelShares)
    .values({ channelId, ownerId, sharedWith })
    .onConflictDoNothing();
  return true;
}

export async function unshareChannel(
  ownerId: string,
  channelId: string,
  sharedWith: string,
): Promise<boolean> {
  const rows = await db
    .delete(channelShares)
    .where(
      and(
        eq(channelShares.channelId, channelId),
        eq(channelShares.ownerId, ownerId),
        eq(channelShares.sharedWith, sharedWith),
      ),
    )
    .returning({ id: channelShares.id });
  return rows.length > 0;
}

export async function listChannelShares(tenantId: string, channelId: string) {
  return db
    .select({ sharedWith: channelShares.sharedWith, createdAt: channelShares.createdAt })
    .from(channelShares)
    .where(and(eq(channelShares.channelId, channelId), eq(channelShares.ownerId, tenantId)));
}

/**
 * Delete a channel for good, and the requests in it.
 *
 * Archiving is the reversible one and keeps everything. This is the other press:
 * the channel and its history go, so nothing is left counting against the
 * workspace's allowance and nothing is left that no page can reach.
 */
export async function deleteSession(
  tenantId: string,
  id: string,
): Promise<boolean> {
  // The requests first: deleting the channel nulls their session_id (deliberately,
  // so a history read never loses rows to a cascade), and after that nothing can
  // find them by channel again.
  await db
    .delete(prompts)
    .where(and(eq(prompts.sessionId, id), eq(prompts.tenantId, tenantId)));
  const rows = await db
    .delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.tenantId, tenantId)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Is this channel URL ending already taken? */
export async function slugTaken(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.slug, slug))
    .limit(1);
  return !!row;
}
