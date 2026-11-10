import { Elysia, t } from "elysia";
import { env } from "../env";
import { apiKeyFromHeaders } from "../lib/crypto";
import { badRequest, paymentRequired, unauthorized } from "../lib/http";
import { broadcastToWatchers } from "../lib/realtime";
import { abortWaiter, waitForDecision } from "../lib/waiters";
import {
  canAffordApproval,
  countAlerts,
  createPrompt,
  expirePrompt,
  getPrompt,
} from "../services/prompts";
import { resolveSession } from "../services/sessions";
import { sendPushToTenant } from "../services/push";
import {
  checkLimit,
  getPlan,
  topUpUrl,
  usageSince,
  REQUESTS_PER_APPROVAL,
} from "../lib/plans";
import {
  consumeTokens,
  createTenant,
  findTenantByApiKey,
  explainKeyRejection,
  findKeyAuth,
  getTenant,
} from "../services/tenants";
import type { Prompt, PromptRoute, Tenant } from "../db/schema";

const MAX_TIMEOUT_MS = 15 * 60 * 1000;
/** Async requests stay answerable for this long by default. */
// Async requests stay answerable for a day, so the operator can check in later.
const ASYNC_TTL_MS = 24 * 60 * 60 * 1000;

export interface HookBody {
  /** Short headline. Derived from the message when omitted. */
  title?: string;
  /** Full body: a command, an intended action, or a clarification ask. */
  message?: string;
  /** Legacy alias for `message` (kept for `curl`/CLI compatibility). */
  command?: string;
  kind?: string;
  cwd?: string;
  agent?: string;
  /** Reuse an existing connection id, or omit to register a new one. */
  connection?: string;
  /** Channel id (alias of connection). */
  channel?: string;
  /** Name for a newly registered connection (e.g. the project name). */
  connectionName?: string;
  /** Channel name (alias of connectionName). */
  channelName?: string;
  /** Legacy aliases for connection/connectionName. */
  session?: string;
  sessionName?: string;
  /**
   * A batch decision: several underlying asks collapsed into one recommended
   * route. When present, the request is a single tap on a route rather than a
   * bare yes/no, and an option list in `message` is allowed.
   */
  route?: PromptRoute;
  metadata?: Record<string, unknown>;
  /** Milliseconds to wait for a human before auto-denying. */
  timeoutMs?: number;
  /**
   * `true` (default) blocks until a decision. `false` returns at once with a
   * `pollUrl`, for callers behind a proxy/CDN that caps response time.
   */
  wait?: boolean;
  /** How long the request stays answerable (defaults to timeoutMs / 10m async). */
  expiresInMs?: number;
}

/** Derive a tidy headline from the first line of a message. */
export function deriveTitle(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "Approval request";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

/**
 * True when a request reads as a menu of choices. A plain request offers only
 * Approve and Deny, so it must be a single yes/no - an option list
 * (zsh/bash/fish, A/B/C, several questions) is unanswerable and is rejected.
 *
 * A request that carries a `route` is the exception: the option list *is* the
 * route, collapsed to one tap, so it is allowed through.
 */
function looksLikeMenu(message: string): boolean {
  const questions = (message.match(/\?/g) || []).length;
  const options = (message.match(/(^|[\s(])[A-D][).]\s/g) || []).length;
  const ors = (message.match(/\bor\b/gi) || []).length;
  return questions >= 3 || options >= 2 || ors >= 3;
}

/** A channel id (11 chars) or a 16-char URL ending is a handle, not a name. */
function looksLikeHandle(value: string): boolean {
  return /^[A-Za-z0-9]{11}$/.test(value) || /^[A-Za-z0-9]{16}$/.test(value);
}

/**
 * Shown when the channel an agent is bound to (or the handle it passed) is gone.
 * Silence here used to mean "a new channel quietly appeared"; this says what
 * happened and what to do next, in one line an agent can act on.
 */
const CHANNEL_GONE_MESSAGE =
  "This channel no longer exists, so the request was not recorded. Re-attach with a " +
  "fresh link (setup.sh --join <url>), or ask the owner for the channel's current link.";

/** Channel names are labels; a runaway handle must not become a 4 KB tab. */
const MAX_CHANNEL_NAME = 80;

/**
 * The name a caller asked for, when what it passed is a name at all.
 *
 * `channel`/`connection`/`session` carry whatever handle the agent was given: an
 * id, a URL ending, a whole link, or the name from an older prompt. When it
 * matches no channel, the caller means "make me that channel" - so the name it
 * asked for must win over the cwd/agent guess. Every DSH session calls itself
 * `dsh`, and without this all of them collapse into one channel named `dsh`,
 * whichever project they came from. Ids and URL endings stay excluded: they
 * address an existing channel, and a stale one must not mint a channel named
 * like a token.
 */
function requestedChannelName(handle?: string | null): string | null {
  const raw = handle?.trim();
  if (!raw) return null;
  // A whole link: the channel is its last path segment ("/main", "/c/<slug>").
  const last = raw.includes("/") ? (raw.split(/[/?#]/).filter(Boolean).pop() ?? raw) : raw;
  const candidate = last.trim();
  if (!candidate || looksLikeHandle(candidate)) return null;
  return candidate.slice(0, MAX_CHANNEL_NAME);
}

/** Name a connection after the project (cwd basename), unless given a name. */
function deriveConnectionName(body: HookBody, requested?: string | null): string | null {
  const explicit = body.channelName ?? body.connectionName ?? body.sessionName;
  if (explicit?.trim()) return explicit.trim().slice(0, MAX_CHANNEL_NAME);
  const asked = requestedChannelName(requested);
  if (asked) return asked;
  if (body.cwd) {
    const base = body.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base) return base.slice(0, MAX_CHANNEL_NAME);
  }
  if (body.agent) return body.agent.slice(0, MAX_CHANNEL_NAME);
  return null;
}

function clampTimeout(requested?: number): number {
  const value = requested && requested > 0 ? requested : env.defaultTimeoutMs;
  return Math.min(Math.max(value, 1_000), MAX_TIMEOUT_MS);
}

interface HookResult {
  approved: boolean;
  promptId: string;
  title: string;
  message: string;
  kind: string;
  status: Prompt["status"];
  reason: string | null;
  /**
   * The human's own words when they answered instead of approving/denying
   * (`status: "answered"`). Read it and act on it.
   */
  answer: string | null;
  /** The batched route, echoed back so the agent sees what the human tapped. */
  route: Prompt["route"];
  /** The route option id the human chose, or null when denied/unbatched. */
  decision: string | null;
  risk: Prompt["risk"];
  riskReasons: string[];
  deviceId: string | null;
  connectionId: string | null;
  /** Alias of connectionId. */
  sessionId: string | null;
  onlineDevices: number;
  /** True when the workspace is out of requests: recorded, but not actionable. */
  limitReached?: boolean;
  limitMessage?: string;
  /** Plan + request usage for this workspace. */
  /** Present when the request minted an anonymous workspace (no key supplied). */
  apiKey?: string;
  workspaceId?: string;
  usage: {
    plan: string;
    requestsToday: number;
    limit: number | null;
    via: string;
    tokenBalance: number;
  };
  createdAt: Date;
  expiresAt: Date;
  /** Present in async mode (`wait: false`): GET this to poll for the answer. */
  pollUrl?: string;
  waiting?: boolean;
}

/**
 * The heart of psh.now: create a prompt, push it to every paired device, then
 * block the agent's HTTP request until a human answers or the timeout fires.
 */
async function handleApprovalRequest(
  headers: Headers,
  body: HookBody,
  signal: AbortSignal,
): Promise<HookResult> {
  // Authenticate by API key, or mint an anonymous workspace on first use - the
  // "zero friction" path, like an anonymous publish.
  const suppliedKey = apiKeyFromHeaders(headers);
  let mintedApiKey: string | undefined;
  let tenant: Tenant;
  let keySessionId: string | null = null;
  let keyId: string | null = null;
  if (suppliedKey) {
    // A channel key is bound to one channel: requests route there by default.
    const auth = await findKeyAuth(suppliedKey);
    if (!auth) {
      // Log *why* - revoked? workspace deleted? - so a dead key is diagnosable.
      const why = await explainKeyRejection(suppliedKey).catch(() => "unknown");
      console.warn(`[auth] rejected key ${suppliedKey.slice(0, 16)}… - ${why}`);
      throw unauthorized(
        "Invalid API key - it may have been revoked, or deleted together with its " +
          "channel. Re-attach with a fresh link (`sh scripts/setup.sh --join <url>`), " +
          "or ask the owner for a new channel key.",
      );
    }
    tenant = auth.tenant;
    keySessionId = auth.sessionId;
    keyId = auth.keyId;
  } else {
    const created = await createTenant("Anonymous");
    tenant = created.tenant;
    mintedApiKey = created.apiKey;
  }
  const timeoutMs = clampTimeout(body.timeoutMs);
  const async = body.wait === false;

  // Plan metering: count alerts in the plan's window before accepting this one.
  const plan = getPlan(tenant.plan);
  const used =
    (await countAlerts(tenant.id, { since: usageSince(plan, tenant.claimedAt) })) *
    REQUESTS_PER_APPROVAL;
  const limit = checkLimit(plan, used, tenant.tokenBalance, undefined, env.publicBaseUrl);
  // Over the allowance: still record the request so the human sees exactly
  // what was blocked (and can top up), but tell the agent straight away.
  const overLimit = !limit.allowed;
  const tokenBalance =
    limit.via === "token"
      ? await consumeTokens(tenant.id, REQUESTS_PER_APPROVAL)
      : tenant.tokenBalance;
  const usage = {
    plan: plan.id,
    requestsToday: used + REQUESTS_PER_APPROVAL,
    limit: limit.limit,
    via: limit.via,
    tokenBalance,
  };

  const rawMessage = (body.message ?? body.command ?? "").trim();
  if (!rawMessage) throw badRequest("Provide a `message` (or legacy `command`)");
  if (body.route) {
    throw badRequest(
      "psh.now shows only Approve and Deny - send one yes/no, not a `route`. " +
        "Pick the path yourself and put it in `message` as \"Recommended: …\".",
    );
  }
  if (looksLikeMenu(rawMessage)) {
    throw badRequest(
      "psh.now has only Approve and Deny - ask one yes/no on your recommendation. " +
        "Do not list options (zsh/bash/fish, A/B/C, several questions). " +
        "Pick one path, put it in `message` as \"Recommended: …\", and ask to proceed.",
    );
  }
  const message = tidyMessage(rawMessage);
  const title = cleanCopy(body.title?.trim() || deriveTitle(message)).slice(0, 200);

  // One key, many connections: reuse the one the caller named, or register it.
  const requested = body.channel ?? body.connection ?? body.session ?? null;
  // The channel this key is bound to, and any handle-shaped string, are
  // *references*: if they no longer resolve, fail loudly instead of quietly
  // creating a replacement channel (or, worse, adopting a channel that happens
  // to share the name). A plain name still creates a channel - that is how an
  // agent opens its first one.
  const reference = requested ?? keySessionId ?? null;
  const connection = await resolveSession(tenant.id, {
    id: reference,
    name: deriveConnectionName(body, requested) ?? "Default",
    agent: body.agent ?? null,
    unresolvedMessage:
      reference && (requested == null || looksLikeHandle(requested))
        ? CHANNEL_GONE_MESSAGE
        : undefined,
  });

  const prompt = await createPrompt({
    tenantId: tenant.id,
    title,
    message,
    kind: body.kind,
    cwd: body.cwd ?? null,
    agent: body.agent ?? null,
    sessionId: connection.id,
    createdByKeyId: keyId,
    route: body.route ?? null,
    // Flagged so the dashboard shows it but refuses to act on it.
    metadata: { ...(body.metadata ?? {}), ...(overLimit ? { limitReached: true } : {}) },
    expiresInMs: body.expiresInMs ?? (async ? ASYNC_TTL_MS : timeoutMs),
  });

  // Push the live event to every connected phone watching this channel: the
  // owner's devices and every account the channel is shared with.
  const online = await broadcastToWatchers(tenant.id, prompt.sessionId, {
    type: "prompt.created",
    prompt: serializePrompt(prompt),
  });

  // Also send a real Web Push so a closed tab/phone still gets alerted.
  void sendPushToTenant(tenant.id, {
    title: prompt.title,
    body: prompt.message.slice(0, 160),
    tag: prompt.id,
    url: "/app",
    promptId: prompt.id,
  });

  const base: HookResult = {
    approved: false,
    promptId: prompt.id,
    title: prompt.title,
    message: prompt.message,
    kind: prompt.kind,
    status: prompt.status,
    reason: null,
    answer: null,
    route: prompt.route,
    decision: null,
    risk: prompt.risk,
    riskReasons: prompt.riskReasons,
    deviceId: null,
    connectionId: connection.id,
    sessionId: connection.id,
    onlineDevices: online,
    usage,
    ...(overLimit
      ? {
          limitReached: true,
          limitMessage:
            limit.message ??
            `Request limit reached - the human needs to add more requests. Add requests: ${topUpUrl(env.publicBaseUrl)}`,
          /** Where to add requests - relay this with the message. */
          topUpUrl: topUpUrl(env.publicBaseUrl),
        }
      : {}),
    ...(mintedApiKey ? { apiKey: mintedApiKey, workspaceId: tenant.id } : {}),
    createdAt: prompt.createdAt,
    expiresAt: prompt.expiresAt,
  };

  // Out of requests: the request is stored so the human sees what was blocked,
  // but it cannot be approved or denied. Tell the agent immediately instead of
  // holding it open for a decision that can't arrive.
  if (overLimit) {
    return {
      ...base,
      reason: "limit_reached",
      pollUrl: `${env.publicBaseUrl}/api/v1/approvals/${prompt.id}`,
      waiting: false,
    };
  }

  // Async mode: return the session so the caller can poll. Nothing blocks, so
  // no proxy/CDN timeout can cut it off.
  if (async) {
    return {
      ...base,
      pollUrl: `${env.publicBaseUrl}/api/v1/approvals/${prompt.id}`,
      waiting: false,
    };
  }

  const onAbort = () => abortWaiter(prompt.id);
  signal.addEventListener("abort", onAbort, { once: true });

  const decision = await waitForDecision(prompt.id, tenant.id, timeoutMs);
  signal.removeEventListener("abort", onAbort);

  let final = prompt;

  // For non-human outcomes the DB row still needs closing.
  if (decision.source === "timeout" || decision.source === "disconnect") {
    const expired = await expirePrompt(tenant.id, prompt.id, decision.reason ?? decision.source);
    // A human may have won the race; fall back to the persisted row.
    final = expired ?? (await getPrompt(tenant.id, prompt.id)) ?? prompt;
  } else {
    final = (await getPrompt(tenant.id, prompt.id)) ?? prompt;
  }

  const approved = final.status === "approved";

  return {
    approved,
    promptId: final.id,
    title: final.title,
    message: final.message,
    kind: final.kind,
    status: final.status,
    reason: final.reason,
    answer: final.answer,
    route: final.route,
    decision: final.decision,
    risk: final.risk,
    riskReasons: final.riskReasons,
    deviceId: final.deviceId,
    connectionId: final.sessionId,
    sessionId: final.sessionId,
    onlineDevices: online,
    usage,
    ...(mintedApiKey ? { apiKey: mintedApiKey, workspaceId: tenant.id } : {}),
    createdAt: final.createdAt,
    expiresAt: final.expiresAt,
    waiting: false,
  };
}

/**
 * Public, agent-facing shape of a prompt (no secrets).
 *
 * `limitReached` is the dashboard's "recorded but not tappable" lock. Pass
 * `canAfford` when serializing *for an approving human*: the lock is then
 * evaluated against the workspace's current balance, so adding requests
 * re-enables a card that was recorded while blocked. Agents (no `canAfford`)
 * keep seeing the reason the request was recorded, which never changes.
 */
export function serializePrompt(prompt: Prompt, opts: { canAfford?: boolean } = {}) {
  const heldForLimit = prompt.metadata?.limitReached === true;
  return {
    id: prompt.id,
    workspaceId: prompt.tenantId,
    connectionId: prompt.sessionId,
    sessionId: prompt.sessionId,
    title: prompt.title,
    message: prompt.message,
    kind: prompt.kind,
    // Legacy alias so older agents/tests keep working.
    command: prompt.message,
    /** Recorded but unactionable: the workspace is out of requests. */
    limitReached:
      // For an approving human this is the live answer, not the create-time note. `heldForLimit`
      // only records why a request was *held*; a request that arrived while the workspace could
      // still pay carries no metadata at all, so keying the lock off it left the buttons live
      // after the balance was gone and the press was refused with no explanation.
      opts.canAfford === undefined ? heldForLimit : !opts.canAfford,
    cwd: prompt.cwd,
    agent: prompt.agent,
    /** The agent key that created the request (short id, safe to display). */
    agentId: prompt.createdByKeyId ? prompt.createdByKeyId.slice(0, 8) : null,
    /**
     * The same key's full id, so a human can rename the agent from anywhere it
     * shows up (the request history names it in place).
     */
    keyId: prompt.createdByKeyId ?? null,
    /** Device that decided, when the decision came from a paired device. */
    decidedByDeviceId: prompt.status === "pending" ? null : (prompt.deviceId ?? null),
    risk: prompt.risk,
    riskReasons: prompt.riskReasons,
    route: prompt.route,
    decision: prompt.decision,
    /** The human's clarification, when they answered instead of deciding. */
    answer: prompt.answer,
    status: prompt.status,
    reason: prompt.reason,
    createdAt: prompt.createdAt,
    expiresAt: prompt.expiresAt,
    decidedAt: prompt.decidedAt,
  };
}

/**
 * Serialize prompts for an **approving human**, with the out-of-requests lock
 * resolved against each owner's live balance. Used by every surface that lets
 * someone tap Approve/Deny: the approvals list and the WebSocket `hello`.
 *
 * Prompts in one list can belong to different workspaces (a channel shared with
 * another account), so affordability is resolved per owning workspace.
 */
export async function serializeForApprover(
  items: Prompt[],
): Promise<ReturnType<typeof serializePrompt>[]> {
  // Resolved live for every list, not only when a prompt already carries the create-time note.
  // Keying it off that note meant a workspace that ran out *after* its requests arrived was never
  // told: the dashboard kept live buttons on requests the server would refuse, and the press did
  // nothing with no explanation, which is exactly what a reload then showed again.
  const affordable = new Map<string, boolean>();
  const out: ReturnType<typeof serializePrompt>[] = [];
  for (const prompt of items) {
    let canAfford = affordable.get(prompt.tenantId);
    if (canAfford === undefined) {
      const owner = await getTenant(prompt.tenantId);
      canAfford = owner ? await canAffordApproval(owner) : false;
      affordable.set(prompt.tenantId, canAfford);
    }
    out.push(serializePrompt(prompt, { canAfford }));
  }
  return out;
}

/**
 * Agents like to prefix copy with a label ("Test 2:", "Task:", "Title:").
 * Strip it and collapse stray whitespace so the card reads cleanly.
 */
function cleanCopy(text: string): string {
  return text
    .replace(/^\s*(?:test(?:\s*\d+)?|task|title|request|approval|question)\s*[:\-–]\s*/i, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Agents are told to phrase the ask as "Recommended: …" so they commit to one
 * path instead of offering a menu. The label is agent-side discipline, not card
 * copy, so it is stripped before the human ever sees it.
 */
function tidyMessage(text: string): string {
  const cleaned = cleanCopy(text);
  const hadLabel = /^\s*recommended\s*:\s*/i.test(cleaned);
  const withoutLabel = cleaned
    .replace(/\brecommended\s*:\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  // A stripped leading label leaves a lowercase sentence behind.
  return hadLabel ? withoutLabel.replace(/^([a-z])/, (m) => m.toUpperCase()) : withoutLabel;
}

const bodySchema = t.Object({
  title: t.Optional(t.String({ maxLength: 200 })),
  message: t.Optional(t.String({ maxLength: 20_000 })),
  command: t.Optional(t.String({ maxLength: 20_000 })),
  kind: t.Optional(t.String({ maxLength: 32 })),
  cwd: t.Optional(t.String({ maxLength: 1024 })),
  agent: t.Optional(t.String({ maxLength: 120 })),
  session: t.Optional(t.String({ maxLength: 32 })),
  sessionName: t.Optional(t.String({ maxLength: 120 })),
  connection: t.Optional(t.String({ maxLength: 32 })),
  channel: t.Optional(t.String({ maxLength: 32 })),
  channelName: t.Optional(t.String({ maxLength: 120 })),
  connectionName: t.Optional(t.String({ maxLength: 120 })),
  route: t.Optional(
    t.Object({
      summary: t.String({ maxLength: 300 }),
      rationale: t.Optional(t.String({ maxLength: 1000 })),
      options: t.Array(
        t.Object({
          id: t.String({ maxLength: 64 }),
          label: t.String({ maxLength: 200 }),
          detail: t.Optional(t.String({ maxLength: 500 })),
          recommended: t.Optional(t.Boolean()),
          asks: t.Optional(
            t.Array(
              t.Object({
                question: t.String({ maxLength: 300 }),
                answer: t.String({ maxLength: 300 }),
              }),
            ),
          ),
        }),
        { minItems: 2, maxItems: 12 },
      ),
    }),
  ),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
  timeoutMs: t.Optional(t.Number({ minimum: 1000, maximum: MAX_TIMEOUT_MS })),
  wait: t.Optional(t.Boolean()),
  expiresInMs: t.Optional(t.Number({ minimum: 1000, maximum: 24 * 60 * 60 * 1000 })),
});

/**
 * Both the canonical `POST /` (matches `curl -X POST https://psh.now`) and the
 * versioned `/api/v1/hook` are exposed.
 */
export const hookRoutes = new Elysia()
  .post("/", ({ request, body }) => handleApprovalRequest(request.headers, body, request.signal), {
    body: bodySchema,
    detail: { summary: "Request human approval (blocks)" },
  })
  .post(
    "/api/v1/approvals",
    ({ request, body }) => handleApprovalRequest(request.headers, body, request.signal),
    { body: bodySchema, detail: { summary: "Create an approval request (blocking or async)" } },
  )
  .post(
    "/api/v1/hook",
    ({ request, body }) => handleApprovalRequest(request.headers, body, request.signal),
    { body: bodySchema, detail: { summary: "Legacy alias of /api/v1/approvals" } },
  );
