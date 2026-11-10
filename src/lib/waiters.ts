/**
 * Registry of callers waiting on a human decision for a prompt.
 *
 * A prompt can have more than one listener at a time: the blocking `POST /`
 * request, a long-polling `GET /api/v1/approvals/:id?wait=…`, and any other
 * observer. Resolving a prompt wakes them all.
 *
 * Kept in-process for the lowest possible latency. Cross-instance delivery is
 * handled separately by Postgres LISTEN/NOTIFY (see lib/pubsub.ts): when a
 * decision lands on another node, it is replayed here via resolveWaiter().
 */

export interface Decision {
  approved: boolean;
  reason?: string | null;
  deviceId?: string | null;
  /** For a batched route: the option id the human chose. */
  decision?: string | null;
  /** The human's own words, when they answered instead of deciding. */
  answer?: string | null;
  /** How the decision was reached, useful for logs and error messages. */
  source: "human" | "timeout" | "disconnect" | "pubsub";
}

interface Waiter {
  tenantId: string;
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, Set<Waiter>>();

/**
 * Block until the prompt is resolved, or until `timeoutMs` elapses
 * (auto-deny). Multiple concurrent callers are supported. Never rejects.
 */
export function waitForDecision(
  promptId: string,
  tenantId: string,
  timeoutMs: number,
): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    const waiter: Waiter = {
      tenantId,
      resolve,
      timer: setTimeout(() => {
        removeWaiter(promptId, waiter);
        resolve({ approved: false, reason: "timed_out", source: "timeout" });
      }, timeoutMs),
    };

    // Do not keep the event loop alive purely for a pending waiter.
    if (typeof waiter.timer === "object" && "unref" in waiter.timer) {
      waiter.timer.unref();
    }

    let set = waiters.get(promptId);
    if (!set) {
      set = new Set();
      waiters.set(promptId, set);
    }
    set.add(waiter);
  });
}

function removeWaiter(promptId: string, waiter: Waiter): void {
  const set = waiters.get(promptId);
  if (!set) return;
  set.delete(waiter);
  if (set.size === 0) waiters.delete(promptId);
}

/** Resolve every local waiter for a prompt. Returns true if any were waiting. */
export function resolveWaiter(promptId: string, decision: Decision): boolean {
  const set = waiters.get(promptId);
  if (!set || set.size === 0) return false;

  waiters.delete(promptId);
  for (const waiter of set) {
    clearTimeout(waiter.timer);
    waiter.resolve(decision);
  }
  return true;
}

/** Resolve a waiter because the agent's connection dropped. */
export function abortWaiter(promptId: string, reason = "agent_disconnected"): void {
  resolveWaiter(promptId, { approved: false, reason, source: "disconnect" });
}

export function hasWaiter(promptId: string): boolean {
  return waiters.has(promptId);
}

export function pendingWaiterCount(): number {
  let count = 0;
  for (const set of waiters.values()) count += set.size;
  return count;
}
