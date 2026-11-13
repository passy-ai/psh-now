/**
 * Plans and limits. psh.now charges for **requests** (one human decision).
 * Members are unlimited on every plan. Paid usage is a prepaid **token package**
 * (100 for €1, 1,000 for €9, 10,000 for €50, 100,000 for €450, excl. VAT), not a
 * subscription.
 *
 * The free ladder: one allowance of 100 requests, **no daily cap**, the same
 * whether the workspace is anonymous or claimed - registering is what buys the
 * dashboard, shares and purchase powers, not a bigger allowance.
 *
 * On top of that sits a free top-up: +20 requests, taken silently, once while
 * anonymous and twenty times in total once claimed. See `TOPUP_LIMIT_ANON`.
 */

import { env } from "../env";

export type PlanId = "anonymous" | "free" | "token" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  /** Included requests per rolling 24h (null = no daily cap in v2). */
  requestsPerDay: number | null;
  /** Lifetime request cap (anonymous + free in v2). */
  requestsTotal: number | null;
  /** History retention window in ms. */
  historyMs: number;
  /** true = refuse beyond the allowance (unless a token is spent). */
  hardCap: boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** One approval = one inbound request + one outbound response. */
export const REQUESTS_PER_APPROVAL = 2;

/**
 * Free requests for everyone, from the very first ask. No daily cap.
 * `PSH_FREE_REQUESTS` lowers it (the wall is easy to reach while testing).
 */
export const FREE_REQUESTS = env.freeRequests;

/**
 * The claim bonus: still free, still no daily cap, and the claiming moment.
 * `PSH_CLAIMED_REQUESTS` tunes it the same way.
 */
export const CLAIMED_REQUESTS = env.claimedRequests;

/**
 * The free top-up: 20 requests, handed out silently.
 *
 * One counter per workspace, shared between the two states, so the ladder reads:
 * an anonymous workspace takes it once, and claiming raises the ceiling to twenty
 * *total* - the grant already taken while anonymous is part of that twenty, not a
 * separate allowance. The mechanic exists to keep someone from hitting a wall
 * before they have decided the product is worth paying for; it is deliberately
 * not advertised, because a visible button that says "free" is a button that gets
 * pressed until it stops working.
 */
export const TOPUP_REQUESTS = 20;

/** How many free top-ups an anonymous workspace may take. */
export const TOPUP_LIMIT_ANON = 1;

/**
 * How many free top-ups a claimed workspace may take in total, counting any
 * already taken while anonymous. Claiming therefore adds nineteen, not twenty.
 */
export const TOPUP_LIMIT_CLAIMED = 20;

/** The ceiling for a workspace, which moves the moment it is claimed. */
export function topUpLimit(claimed: boolean): number {
  return claimed ? TOPUP_LIMIT_CLAIMED : TOPUP_LIMIT_ANON;
}

/** Trial workspaces keep living as long as they were used in the last 120d. */
export const TRIAL_KEEP_ALIVE_MS = 120 * DAY;

/** The prepaid packs, the only things that cost money. */
export const TOKEN_PACKAGES = [
  {
    // The entry pack. Cheap on purpose: €1 is small enough to be an easy yes, and
    // it is the first thing anyone buys after the free allowance runs out.
    id: "entry",
    requests: 100,
    priceEur: 1,
  },
  {
    id: "starter",
    requests: 1_000,
    priceEur: 9,
  },
  {
    id: "team",
    requests: 10_000,
    priceEur: 50,
  },
  {
    id: "scale",
    requests: 100_000,
    priceEur: 450,
  },
] as const;

export type TokenPackage = (typeof TOKEN_PACKAGES)[number];

/**
 * Back-compat: the historical "the one pack" (team size). Some meters and copy
 * still name it; the canonical list is TOKEN_PACKAGES.
 */
export const TOKEN_PACKAGE: TokenPackage =
  TOKEN_PACKAGES.find((p) => p.id === "starter") ?? TOKEN_PACKAGES[0];

export function pickTokenPackage(requests?: number | null): TokenPackage | null {
  if (requests == null) return TOKEN_PACKAGES[0];
  return TOKEN_PACKAGES.find((p) => p.requests === requests) ?? null;
}

export const PACKS_LINE =
  "Packs: 100 requests for €1, 1,000 for €9, 10,000 for €50, 100,000 for €450 (never expire).";

/**
 * Where a blocked workspace adds requests: the dashboard's account menu, opened
 * straight onto the Buy item. The app understands the `#topup` hash, so a link
 * in a limit message lands on the action instead of the top of the page.
 */
export const TOP_UP_PATH = "/app#topup";

/** Absolute top-up URL for a deployment. */
export function topUpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${TOP_UP_PATH}`;
}

export const PLANS: Record<PlanId, Plan> = {
  anonymous: {
    id: "anonymous",
    name: "Anonymous",
    requestsPerDay: null,
    requestsTotal: FREE_REQUESTS,
    historyMs: 7 * DAY,
    hardCap: true,
  },
  free: {
    id: "free",
    name: "Free",
    requestsPerDay: null,
    requestsTotal: CLAIMED_REQUESTS,
    historyMs: 30 * DAY,
    hardCap: true,
  },
  token: {
    id: "token",
    name: "Token",
    // History only: nothing assigns this plan any more (a prepaid purchase keeps
    // a workspace on `free`, addTokens() no longer touches `plan`). Kept so old
    // rows still resolve to something sane.
    // No daily cap in v2: the prepaid balance is the only meter.
    requestsPerDay: null,
    requestsTotal: null,
    historyMs: 90 * DAY,
    hardCap: false,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    requestsPerDay: null,
    requestsTotal: null,
    historyMs: 3650 * DAY,
    hardCap: false,
  },
};

export function getPlan(id: string | null | undefined): Plan {
  return PLANS[(id ?? "free") as PlanId] ?? PLANS.free;
}

/**
 * The usage-counting window. v2 racks are *total*, so the count is all-time
 * (null = no `since` filter in the service).
 */
export function usageSince(plan: Plan, claimedAt?: Date | null): Date | null {
  if (plan.requestsTotal !== null) return null;
  const dayAgo = new Date(Date.now() - DAY);
  // A freshly claimed workspace starts its free window at claim time.
  if (claimedAt && claimedAt > dayAgo) return claimedAt;
  return dayAgo;
}

/** History cutoff for reads, or null when unlimited. */
export function historyCutoff(plan: Plan): Date | null {
  return plan.historyMs > 0 ? new Date(Date.now() - plan.historyMs) : null;
}

export type LimitVia = "allowance" | "token" | "blocked";

export interface LimitCheck {
  allowed: boolean;
  limit: number | null;
  used: number;
  via: LimitVia;
  plan: Plan;
  message?: string;
}

/**
 * Decide whether one more approval is allowed for a plan already at `used`
 * requests. Each approval costs `cost` (inbound + outbound). Beyond the free
 * allowance, prepaid tokens are spent when available.
 *
 * v2 semantics: anonymous and free have one *total* rack with **no daily
 * cap**; the prepaid balance is the only other meter (enterprise is unmetered).
 */
export function checkLimit(
  plan: Plan,
  used: number,
  tokenBalance = 0,
  cost = REQUESTS_PER_APPROVAL,
  /**
   * Public base URL of the deployment. When given, every blocked message ends
   * with the top-up link, an agent that relays the message relays the link, and
   * the human has somewhere to click (owner: a limit report with no link is
   * "a bit sad").
   */
  baseUrl?: string,
): LimitCheck {
  const withLink = (message: string) =>
    baseUrl ? `${message} Add requests: ${topUpUrl(baseUrl)}` : message;
  // One total rack, no daily cap, the wall arrives once, at rack-empty time.
  if (plan.requestsTotal !== null) {
    if (used + cost <= plan.requestsTotal) {
      return { allowed: true, limit: plan.requestsTotal, used, via: "allowance", plan };
    }
    if (tokenBalance >= cost) {
      return { allowed: true, limit: plan.requestsTotal, used, via: "token", plan };
    }
    /**
     * One message for both states now that the allowance is the same either way.
     * It names no free top-up on purpose: the mechanic is silent, and a limit
     * message that advertises "you can still get more for free" is the one place
     * it would leak to every agent's terminal.
     */
    const next = withLink(
      `Free allowance reached (${plan.requestsTotal} requests). ${PACKS_LINE}`,
    );
    return {
      allowed: false,
      limit: plan.requestsTotal,
      used,
      via: "blocked",
      plan,
      message: next,
    };
  }

  if (plan.requestsPerDay === null) {
    // Prepaid (token) or unmetered (enterprise). A workspace on the token
    // plan must hold a balance; enterprise is unmetered by design.
    if (plan.hardCap && plan.id !== "enterprise" && tokenBalance < cost) {
      return {
        allowed: false,
        limit: null,
        used,
        via: "blocked",
        plan,
        message: withLink(`Out of requests. ${PACKS_LINE}`),
      };
    }
    return { allowed: true, limit: null, used, via: "allowance", plan };
  }

  // Legacy daily-cap plans (kept for a possible rollback).
  if (used + cost <= plan.requestsPerDay) {
    return { allowed: true, limit: plan.requestsPerDay, used, via: "allowance", plan };
  }

  if (tokenBalance >= cost) {
    return { allowed: true, limit: plan.requestsPerDay, used, via: "token", plan };
  }

  return {
    allowed: false,
    limit: plan.requestsPerDay,
    used,
    via: "blocked",
    plan,
    message: withLink(
      `Daily free limit reached (${plan.requestsPerDay} requests/day). ${PACKS_LINE}`,
    ),
  };
}

/**
 * True for a request that came from the machine itself. The deployed host is everything else, and
 * the two see different packs: this is the switch, in one place.
 */
export function isLocalRequest(request: Request): boolean {
  try {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
