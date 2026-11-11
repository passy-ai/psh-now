import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditLog,
  prompts,
  type Prompt,
  type PromptRoute,
  type PromptStatus,
} from "../db/schema";
import { assessCommand } from "../lib/risk";
import { checkLimit, getPlan, usageSince, REQUESTS_PER_APPROVAL } from "../lib/plans";

export interface CreatePromptInput {
  tenantId: string;
  /** Short headline shown as the alert title. */
  title: string;
  /** Full body: a command, an intended action, or a clarification ask. */
  message: string;
  kind?: string;
  cwd?: string | null;
  agent?: string | null;
  sessionId?: string | null;
  /** The API key that created this request (for `ask`-key read scoping). */
  createdByKeyId?: string | null;
  /** A batch decision: several asks collapsed into one recommended route. */
  route?: PromptRoute | null;
  metadata?: Record<string, unknown>;
  /** How long the request stays answerable before it expires. */
  expiresInMs: number;
}

/** Persist a new pending approval request, with risk analysis attached. */
export async function createPrompt(input: CreatePromptInput): Promise<Prompt> {
  const { risk, reasons } = assessCommand(`${input.title}\n${input.message}`);
  const expiresAt = new Date(Date.now() + input.expiresInMs);

  const [prompt] = await db
    .insert(prompts)
    .values({
      tenantId: input.tenantId,
      title: input.title,
      message: input.message,
      kind: input.kind ?? "action",
      cwd: input.cwd ?? null,
      agent: input.agent ?? null,
      sessionId: input.sessionId ?? null,
      createdByKeyId: input.createdByKeyId ?? null,
      risk,
      riskReasons: reasons,
      route: input.route ?? null,
      metadata: input.metadata ?? {},
      expiresAt,
    })
    .returning();

  if (!prompt) throw new Error("Failed to create prompt");

  await writeAudit(input.tenantId, prompt.id, "prompt.created", {
    risk,
    reasons,
    ...(input.route ? { route: input.route.summary } : {}),
  });

  return prompt;
}

export async function getPrompt(
  tenantId: string,
  promptId: string,
): Promise<Prompt | null> {
  const [prompt] = await db
    .select()
    .from(prompts)
    .where(and(eq(prompts.id, promptId), eq(prompts.tenantId, tenantId)))
    .limit(1);
  return prompt ?? null;
}

/** Fetch a prompt by id regardless of owner (callers must check access). */
export async function getPromptAny(promptId: string): Promise<Prompt | null> {
  const [prompt] = await db
    .select()
    .from(prompts)
    .where(eq(prompts.id, promptId))
    .limit(1);
  return prompt ?? null;
}

export interface ListPromptsOptions {
  status?: PromptStatus;
  sessionId?: string;
  /** Only prompts created by this key (used to scope `ask` keys to their own). */
  createdByKeyId?: string;
  /** Only include prompts created at/after this time (history window). */
  since?: Date | null;
  limit?: number;
}

export async function listPrompts(
  tenantId: string,
  options: ListPromptsOptions = {},
): Promise<Prompt[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const conditions = [eq(prompts.tenantId, tenantId)];
  if (options.status) conditions.push(eq(prompts.status, options.status));
  if (options.sessionId) conditions.push(eq(prompts.sessionId, options.sessionId));
  if (options.createdByKeyId) conditions.push(eq(prompts.createdByKeyId, options.createdByKeyId));
  if (options.since) conditions.push(gte(prompts.createdAt, options.since));

  return db
    .select()
    .from(prompts)
    .where(and(...conditions))
    .orderBy(desc(prompts.createdAt))
    .limit(limit);
}

/**
 * Every request in one channel inside the plan's history window, for the CSV
 * export.
 *
 * `listPrompts` pages at 200 rows because it feeds a scrolling list; an export
 * that stopped where the list does would be missing rows the person can still
 * scroll to. Paged here by (createdAt, id) instead of createdAt alone: a burst of
 * requests can share a millisecond, and a plain `createdAt <` cursor would drop
 * the rest of that millisecond from the file without a word.
 */
export async function listChannelHistory(
  tenantId: string,
  sessionId: string,
  options: { since?: Date | null; max?: number } = {},
): Promise<Prompt[]> {
  const max = Math.min(options.max ?? 5000, 5000);
  const page = 200;
  const out: Prompt[] = [];
  let before: { at: Date; id: string } | null = null;

  while (out.length < max) {
    const conditions = [eq(prompts.tenantId, tenantId), eq(prompts.sessionId, sessionId)];
    if (options.since) conditions.push(gte(prompts.createdAt, options.since));
    if (before) {
      conditions.push(
        or(
          lt(prompts.createdAt, before.at),
          and(eq(prompts.createdAt, before.at), lt(prompts.id, before.id)),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(prompts)
      .where(and(...conditions))
      .orderBy(desc(prompts.createdAt), desc(prompts.id))
      .limit(Math.min(page, max - out.length));
    out.push(...rows);
    // A short page is the end of the history.
    if (rows.length < page) break;
    const last = rows[rows.length - 1]!;
    before = { at: last.createdAt, id: last.id };
  }
  return out;
}

/** Pending prompts across a set of channels (used for shared channels). */
export async function listPendingForChannels(
  channelIds: string[],
  limit = 50,
): Promise<Prompt[]> {
  if (channelIds.length === 0) return [];
  return db
    .select()
    .from(prompts)
    .where(and(inArray(prompts.sessionId, channelIds), eq(prompts.status, "pending")))
    .orderBy(desc(prompts.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Count alerts (created prompts) for usage metering. */
export async function countAlerts(
  tenantId: string,
  options: { since?: Date | null } = {},
): Promise<number> {
  const conditions = [eq(prompts.tenantId, tenantId)];
  if (options.since) conditions.push(gte(prompts.createdAt, options.since));
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompts)
    .where(and(...conditions));
  return row?.count ?? 0;
}

/**
 * Whether a workspace can afford one more approval **right now**.
 *
 * The out-of-requests state is a live check, never a snapshot. A request that
 * was recorded while the workspace was blocked has to become actionable again
 * the moment the workspace can pay for it, tokens added, or the free window
 * rolled over. `prompts.metadata.limitReached` records only *why* a request was
 * held, so the dashboard re-checks affordability on every read.
 */
export async function canAffordApproval(tenant: {
  id: string;
  plan: string | null;
  tokenBalance: number;
  claimedAt: Date | null;
}): Promise<boolean> {
  const plan = getPlan(tenant.plan);
  const used =
    (await countAlerts(tenant.id, { since: usageSince(plan, tenant.claimedAt) })) *
    REQUESTS_PER_APPROVAL;
  return checkLimit(plan, used, tenant.tokenBalance).allowed;
}

export interface DecisionInput {
  approved: boolean;
  reason?: string | null;
  deviceId?: string | null;
  /** For a batched route: the id of the option the human chose. */
  decision?: string | null;
  /**
   * The human's own words. When this is a non-empty string the prompt is
   * `answered` rather than approved/denied, the agent reads it and acts.
   */
  answer?: string | null;
}

/**
 * Atomically resolve a pending prompt. Returns null when the prompt does not
 * exist for the tenant or was already decided (safe against double-taps).
 */
export async function decidePrompt(
  tenantId: string,
  promptId: string,
  input: DecisionInput,
): Promise<Prompt | null> {
  // A typed answer wins over the yes/no flags: the human chose the third
  // button, so the outcome is "read this", not a decision.
  const answer = input.answer?.trim() ? input.answer.trim() : null;
  const status = answer ? "answered" : input.approved ? "approved" : "denied";

  const [prompt] = await db
    .update(prompts)
    .set({
      status,
      answer,
      reason: input.reason ?? null,
      decision: input.decision ?? null,
      deviceId: input.deviceId ?? null,
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(prompts.id, promptId),
        eq(prompts.tenantId, tenantId),
        eq(prompts.status, "pending"),
      ),
    )
    .returning();

  if (!prompt) return null;

  await writeAudit(
    tenantId,
    promptId,
    answer ? "prompt.answered" : input.approved ? "prompt.approved" : "prompt.denied",
    {
      reason: input.reason ?? null,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(answer ? { answer } : {}),
    },
    input.deviceId ?? null,
  );

  return prompt;
}

/** Mark a prompt as expired (timeout or agent disconnect). */
export async function expirePrompt(
  tenantId: string,
  promptId: string,
  reason: string,
): Promise<Prompt | null> {
  const [prompt] = await db
    .update(prompts)
    .set({ status: "expired", reason, decidedAt: new Date() })
    .where(
      and(
        eq(prompts.id, promptId),
        eq(prompts.tenantId, tenantId),
        eq(prompts.status, "pending"),
      ),
    )
    .returning();

  if (!prompt) return null;

  await writeAudit(tenantId, promptId, "prompt.expired", { reason });
  return prompt;
}

export async function writeAudit(
  tenantId: string,
  promptId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
  deviceId: string | null = null,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      tenantId,
      promptId,
      deviceId,
      action,
      detail,
    });
  } catch (err) {
    // Audit failures must never break the transaction flow.
    console.error("[audit] write failed", err);
  }
}

export async function countPending(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompts)
    .where(and(eq(prompts.tenantId, tenantId), eq(prompts.status, "pending")));
  return row?.count ?? 0;
}

/**
 * Close pending prompts whose answer window has passed. Without this, async
 * requests (which no waiter is blocking on) would stay pending forever.
 */
export async function expireStalePrompts(): Promise<number> {
  const rows = await db
    .update(prompts)
    .set({ status: "expired", reason: "timed_out", decidedAt: new Date() })
    .where(and(eq(prompts.status, "pending"), lt(prompts.expiresAt, new Date())))
    .returning({ id: prompts.id });
  return rows.length;
}
