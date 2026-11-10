import { canAffordApproval, decidePrompt, writeAudit } from "./prompts";
import { consumeTokens, getTenant } from "./tenants";
import { checkLimit, getPlan, usageSince, REQUESTS_PER_APPROVAL } from "../lib/plans";
import { countAlerts } from "./prompts";
import { publishDecision, decisionFromEvent, type DecisionEvent } from "../lib/pubsub";
import { broadcastToWatchers } from "../lib/realtime";
import { resolveWaiter, waitForDecision, type Decision } from "../lib/waiters";

/**
 * Apply a human decision: atomically flip the DB row, fan it out to other
 * nodes, and unblock the local agent request if it happens to be here.
 *
 * Returns false when the prompt was already decided or does not exist.
 */
/** Why a decision did or did not apply. */
export type DecisionOutcome = "applied" | "already" | "blocked";

export interface DecisionResult {
  outcome: DecisionOutcome;
  /** When blocked, the gateway's own words, with the top-up link in them. */
  message?: string;
}

export async function recordDecision(event: DecisionEvent): Promise<DecisionResult> {
  // Out of requests: a prompt can still be seen and received, but it cannot be answered,
  // accepted or denied until the workspace can pay for it again. Checked here rather than in
  // each route because every decision and every typed answer arrives through this one function,
  // and it is a live check: the same press works the moment tokens are added.
  const tenant = await getTenant(event.tenantId);
  if (tenant) {
    // Out of requests: a prompt can still be seen and received, but it cannot be answered,
    // accepted or denied until the workspace can pay for it again. This is a live check, so the
    // very same press works the moment tokens are added.
    const plan = getPlan(tenant.plan);
    const used =
      (await countAlerts(tenant.id, { since: usageSince(plan, tenant.claimedAt) })) *
      REQUESTS_PER_APPROVAL;
    const limit = checkLimit(plan, used, tenant.tokenBalance);
    if (!limit.allowed) return { outcome: "blocked", message: limit.message };
    // Beyond the free allowance the decision itself is paid for, out of the same tokens the
    // request came from. Without this a balance was a one-off entry fee: it never went down on a
    // decision, so a workspace over its allowance could keep answering forever.
    if (limit.via === "token") {
      await consumeTokens(tenant.id, REQUESTS_PER_APPROVAL);
    }
  }

  const prompt = await decidePrompt(event.tenantId, event.promptId, {
    approved: event.approved,
    reason: event.reason ?? null,
    decision: event.decision ?? null,
    answer: event.answer ?? null,
    deviceId: event.deviceId ?? null,
  });

  // Lost the race (double tap, expired, or wrong tenant).
  if (!prompt) return { outcome: "already" };

  await publishDecision(event);

  // Resolve immediately on the origin node; the pub/sub hop is a safety net
  // for waiters living on other nodes.
  resolveWaiter(event.promptId, decisionFromEvent(event));
  return { outcome: "applied" };
}

/**
 * Invoked for every decision received over LISTEN/NOTIFY (including ones this
 * node published). Unblocks any local waiter and pushes a live frame to every
 * device watching the channel, the owner's devices and, since the channel is
 * shared with them, each shared account's devices too.
 */
export async function handleDecisionEvent(event: DecisionEvent): Promise<void> {
  resolveWaiter(event.promptId, decisionFromEvent(event));

  await broadcastToWatchers(event.tenantId, event.sessionId ?? null, {
    type: "prompt.decided",
    promptId: event.promptId,
    approved: event.approved,
    answer: event.answer ?? null,
    reason: event.reason ?? null,
    decision: event.decision ?? null,
    deviceId: event.deviceId ?? null,
  });
}

export { waitForDecision, type Decision };
