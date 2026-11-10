import { sql } from "../db";
import type { Decision } from "./waiters";

/**
 * Cross-instance fan-out for decisions using Postgres LISTEN/NOTIFY.
 *
 * The agent's blocked promise lives on whichever node accepted the HTTP
 * request. The phone's WebSocket may connect to a different node. Publishing a
 * decision over NOTIFY lets *every* node resolve a matching waiter locally.
 */

export const DECISION_CHANNEL = "psh_decisions";

export interface DecisionEvent {
  promptId: string;
  tenantId: string;
  approved: boolean;
  reason?: string | null;
  deviceId?: string | null;
  /** For a batched route: the option id the human chose. */
  decision?: string | null;
  /** The human's own words, when they answered instead of deciding. */
  answer?: string | null;
  /** The channel the prompt lives on — lets every node fan the frame out to accounts the channel is shared with. */
  sessionId?: string | null;
}

type Handler = (event: DecisionEvent) => void;

let listenHandle: { unlisten: () => Promise<void> } | null = null;

/** Begin listening for decisions. Safe to call once at boot. */
export async function startPubSub(onDecision: Handler): Promise<void> {
  if (listenHandle) return;

  listenHandle = await sql.listen(DECISION_CHANNEL, (payload) => {
    try {
      const event = JSON.parse(payload) as DecisionEvent;
      if (event?.promptId) {
        // The handler may await (share lookups); never float the rejection.
        Promise.resolve(onDecision(event)).catch((err) =>
          console.error("[pubsub] decision handler failed", err),
        );
      }
    } catch (err) {
      console.error("[pubsub] malformed decision payload", err);
    }
  });

  console.log(`📡 Listening for decisions on channel "${DECISION_CHANNEL}"`);
}

/** Broadcast a decision to all nodes (including this one). */
export async function publishDecision(event: DecisionEvent): Promise<void> {
  try {
    await sql.notify(DECISION_CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error("[pubsub] notify failed", err);
  }
}

export function decisionFromEvent(event: DecisionEvent): Decision {
  return {
    approved: event.approved,
    reason: event.reason ?? null,
    deviceId: event.deviceId ?? null,
    decision: event.decision ?? null,
    answer: event.answer ?? null,
    source: "pubsub",
  };
}

export async function stopPubSub(): Promise<void> {
  if (!listenHandle) return;
  await listenHandle.unlisten();
  listenHandle = null;
}
