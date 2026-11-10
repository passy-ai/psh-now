import { eq, or } from "drizzle-orm";
import { db } from "../db";
import { sessions } from "../db/schema";
import { sha256 } from "../lib/crypto";
import { env } from "../env";
import { createApiKey, randomAgentName } from "./keys";

export interface RedeemedJoin {
  tenantId: string;
  /** A NEW channel key bound to the account. Never the management/user key. */
  channelKey: string;
  sessionId: string | null;
  /**
   * What the key is *for*, so the joiner can store and print it. Without these a
   * joined project could only fall back to the host URL and the word "Default",
   * which is what its report and its sandbox prompt would show (observed on the
   * native run, 2026-10-17).
   */
  channelName: string | null;
  channelUrl: string | null;
}

/**
 * Is this connect link still usable? Read-only, for the page's own check: a
 * link whose channel is gone still renders, and saying so beats letting an agent
 * discover it as a bare 410 mid-task.
 */
export async function peekChannelUrl(idOrSlug: string): Promise<boolean> {
  if (!idOrSlug) return false;
  const [channel] = await db
    .select({ id: sessions.id, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(or(eq(sessions.id, idOrSlug), eq(sessions.slug, idOrSlug)))
    .limit(1);
  if (!channel) return false;
  return !channel.archivedAt;
}

/**
 * Redeem a channel URL (`/c/<id-or-slug>`) for a fresh ask-only key bound to
 * that channel. Reusable, many agents can connect through the same one.
 */
export async function redeemChannelUrl(
  idOrSlug: string,
): Promise<RedeemedJoin | null> {
  const [channel] = await db
    .select()
    .from(sessions)
    .where(or(eq(sessions.id, idOrSlug), eq(sessions.slug, idOrSlug)))
    .limit(1);
  if (!channel || channel.archivedAt) return null;

  const { key } = await createApiKey(channel.tenantId, randomAgentName(), {
    scope: "ask",
    sessionId: channel.id,
  });
  return {
    tenantId: channel.tenantId,
    channelKey: key,
    sessionId: channel.id,
    channelName: channel.name ?? null,
    channelUrl: `${env.publicBaseUrl}/c/${channel.slug || channel.id}`,
  };
}
