import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";
import { channelInvites, sessions } from "../db/schema";
import { sha256 } from "../lib/crypto";
import { newPairingToken } from "../lib/ids";
import { env } from "../env";
import { createApiKey, randomAgentName } from "./keys";
import { shareChannel } from "./sessions";

/**
 * Invite links expire after **24 hours**. A short life is the security model:
 * the owner refreshes the link (see the share menu) whenever they need a new
 * one, so a leaked link is useless by tomorrow.
 */
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** The same window, for copy that has to explain it. */
export const INVITE_TTL_HOURS = 24;

export interface CreatedInvite {
  id: string;
  email: string | null;
  token: string;
  url: string;
  expiresAt: Date;
}

/**
 * Create an invite to a channel. With an email it is addressed to that person;
 * without one it is an **open link** the owner can send wherever.
 *
 * One link serves both audiences, and who opens it decides what they become:
 * a **person** who signs in joins as a member (approver), while an **agent**
 * that fetches the link redeems it for an ask-only key — a requester. See
 * `redeemInviteToken()` and `acceptInviteByToken()`.
 */
export async function createChannelInvite(
  ownerId: string,
  channelId: string,
  email?: string | null,
): Promise<CreatedInvite> {
  const token = newPairingToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(channelInvites)
    .values({
      channelId,
      ownerId,
      email: email?.trim().toLowerCase() || null,
      tokenHash: sha256(token),
      // Kept so the owner can be shown their own live link again; lookups
      // still go through the hash.
      token,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("Failed to create invite");
  return {
    id: row.id,
    email: row.email,
    token,
    url: `${env.publicBaseUrl}/invite/${token}`,
    expiresAt,
  };
}

/**
 * The live (unaccepted, unrevoked, unexpired) invite for a channel, if any.
 *
 * `token` may be null on rows minted before the column existed; callers that
 * need a link to show should mint a replacement in that case
 * (`retireUnshowableInvite`).
 */
export async function activeChannelInvite(ownerId: string, channelId: string) {
  const [row] = await db
    .select()
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.ownerId, ownerId),
        eq(channelInvites.channelId, channelId),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
        isNull(channelInvites.revokedAt),
        gt(channelInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(channelInvites.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Retire a live invite whose raw token was never stored (minted before that
 * column existed) so a fresh, showable link can take its place. Returns the
 * number of rows retired — one at most, in practice.
 */
export async function retireUnshowableInvite(
  ownerId: string,
  channelId: string,
): Promise<boolean> {
  const live = await activeChannelInvite(ownerId, channelId);
  if (!live || live.token) return false;
  await db
    .update(channelInvites)
    .set({ revokedAt: new Date() })
    .where(eq(channelInvites.id, live.id));
  return true;
}

/**
 * Revoke every live invite for a channel. The raw token is kept (for links
 * minted since that column existed) but a revoked row will never be served
 * again: the panel's refresh mints a replacement.
 */
export async function revokeChannelInvites(
  ownerId: string,
  channelId: string,
): Promise<number> {
  const rows = await db
    .update(channelInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(channelInvites.ownerId, ownerId),
        eq(channelInvites.channelId, channelId),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.revokedAt),
      ),
    )
    .returning({ id: channelInvites.id });
  return rows.length;
}

/**
 * Revoke one invite row — what the share panel's remove does to a pending
 * invite (and to a stale/expired one, so the list can be tidied up). An invite
 * someone already accepted is a membership, not an invite, and is never
 * revoked here; removing that person goes through `unshareChannel`.
 */
export async function revokeChannelInvite(
  ownerId: string,
  channelId: string,
  inviteId: string,
): Promise<boolean> {
  const rows = await db
    .update(channelInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(channelInvites.id, inviteId),
        eq(channelInvites.ownerId, ownerId),
        eq(channelInvites.channelId, channelId),
        isNull(channelInvites.acceptedAt),
      ),
    )
    .returning({ id: channelInvites.id });
  return rows.length > 0;
}

export async function listChannelInvites(ownerId: string, channelId: string) {
  return db
    .select()
    .from(channelInvites)
    .where(
      and(eq(channelInvites.ownerId, ownerId), eq(channelInvites.channelId, channelId)),
    );
}

/** Pending (not yet accepted/declined/revoked) invites for a channel. */
export async function countChannelInvites(
  ownerId: string,
  channelId: string,
): Promise<number> {
  const rows = await db
    .select({ id: channelInvites.id })
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.ownerId, ownerId),
        eq(channelInvites.channelId, channelId),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
        isNull(channelInvites.revokedAt),
      ),
    );
  return rows.length;
}

/** Pending invites addressed to this email. */
export async function listInvitesForEmail(email: string) {
  return db
    .select()
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.email, email.trim().toLowerCase()),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
        gt(channelInvites.expiresAt, new Date()),
      ),
    );
}


/** Accept a pending invite by id, granting the account access to the channel. */
export async function acceptInvite(
  tenantId: string,
  email: string,
  inviteId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.id, inviteId),
        eq(channelInvites.email, email.trim().toLowerCase()),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
        gt(channelInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return false;
  await db
    .update(channelInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(channelInvites.id, row.id));
  return shareChannel(row.ownerId, row.channelId, tenantId);
}

export async function declineInvite(
  email: string,
  inviteId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.id, inviteId),
        eq(channelInvites.email, email.trim().toLowerCase()),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
      ),
    )
    .limit(1);
  if (!row) return false;
  await db
    .update(channelInvites)
    .set({ declinedAt: new Date() })
    .where(eq(channelInvites.id, row.id));
  return true;
}

/** Accept an invite from its token (used by the /invite/:token page). */
export async function acceptInviteByToken(
  tenantId: string,
  token: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.tokenHash, sha256(token)),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
        isNull(channelInvites.revokedAt),
        gt(channelInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return false;
  await db
    .update(channelInvites)
    .set({ acceptedAt: new Date(), acceptedBy: tenantId })
    .where(eq(channelInvites.id, row.id));
  return shareChannel(row.ownerId, row.channelId, tenantId);
}

/**
 * Redeem an invite link as an **agent**: a fresh ask-only key on the owner's
 * account, bound to the invited channel.
 *
 * Unlike `acceptInviteByToken()` this does **not** consume the invite — several
 * agents (and, until someone signs in, a person) can use the same live link,
 * which is what makes one link enough. Ask-only means a requester: it can send
 * requests to the channel but can never read or approve anything.
 */
export async function redeemInviteToken(
  token: string,
): Promise<{
  tenantId: string;
  channelKey: string;
  sessionId: string | null;
  channelName: string | null;
  channelUrl: string | null;
} | null> {
  const [row] = await db
    .select()
    .from(channelInvites)
    .where(
      and(
        eq(channelInvites.tokenHash, sha256(token)),
        isNull(channelInvites.acceptedAt),
        isNull(channelInvites.declinedAt),
        isNull(channelInvites.revokedAt),
        gt(channelInvites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;

  const { key } = await createApiKey(row.ownerId, randomAgentName(), {
    scope: "ask",
    sessionId: row.channelId,
  });
  // Same reason as redeemChannelUrl: the joiner stores what it is given, so a link
  // that carries no channel name leaves the project showing "Default" and the host.
  const [channel] = row.channelId
    ? await db
        .select({ name: sessions.name, slug: sessions.slug, id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, row.channelId))
        .limit(1)
    : [];
  return {
    tenantId: row.ownerId,
    channelKey: key,
    sessionId: row.channelId,
    channelName: channel?.name ?? null,
    channelUrl: channel ? `${env.publicBaseUrl}/c/${channel.slug || channel.id}` : null,
  };
}

/** Look up an invite token without consuming it (for the accept page). */
export async function peekInvite(token: string) {
  const [row] = await db
    .select({
      id: channelInvites.id,
      email: channelInvites.email,
      channelId: channelInvites.channelId,
      channelName: sessions.name,
      expiresAt: channelInvites.expiresAt,
      acceptedAt: channelInvites.acceptedAt,
      declinedAt: channelInvites.declinedAt,
      revokedAt: channelInvites.revokedAt,
    })
    .from(channelInvites)
    .leftJoin(sessions, eq(sessions.id, channelInvites.channelId))
    .where(eq(channelInvites.tokenHash, sha256(token)))
    .limit(1);
  return row ?? null;
}
