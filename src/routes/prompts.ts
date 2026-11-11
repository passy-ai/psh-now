import { Elysia, t } from "elysia";
import { requireTenantOrDevice } from "../lib/tenant-auth";
import { apiKeyFromHeaders } from "../lib/crypto";
import { notFound, paymentRequired, badRequest, forbidden } from "../lib/http";
import { joinPrompt } from "../lib/prompt-templates";
import {
  countAlerts,
  createPrompt,
  expirePrompt,
  getPrompt,
  getPromptAny,
  listPrompts,
  type ListPromptsOptions,
} from "../services/prompts";
import { recordDecision } from "../services/decisions";
import { broadcast, broadcastToWatchers, onlineDeviceIds } from "../lib/realtime";
import { resolveWaiter, waitForDecision } from "../lib/waiters";
import { serializePrompt, serializeForApprover } from "./hook";
import { revokeDevice, listDevices, renameDevice } from "../services/devices";
import {
  canAccessChannel,
  createSession,
  deleteSession,
  getSession,
  getSessionById,
  listChannelShares,
  listSessions,
  setSessionArchived,
  shareChannel,
  unshareChannel,
  updateSession,
} from "../services/sessions";
import { sendPushToTenant } from "../services/push";
import { signExportToken, verifyExportToken } from "../lib/export-token";
import { buildChannelExport, countChannelExport } from "../services/export";
import { consumeTokens } from "../services/tenants";
import { approverOf, findKeyAuth, findTenantByEmail, getTenant } from "../services/tenants";
import {
  activeChannelInvite,
  countChannelInvites,
  createChannelInvite,
  listChannelInvites,
  retireUnshowableInvite,
  revokeChannelInvite,
  revokeChannelInvites,
} from "../services/invites";
import {
  createApiKey,
  countChannelKeys,
  listChannelKeys,
  randomAgentName,
  renameApiKey,
  revokeApiKey,
} from "../services/keys";
import {
  checkLimit,
  getPlan,
  topUpUrl,
  historyCutoff,
  usageSince,
  REQUESTS_PER_APPROVAL,
} from "../lib/plans";
import { env } from "../env";

/** Public shape of a session. */
function serializeSession(s: {
  id: string;
  name: string;
  slug?: string | null;
  color?: string | null;
  description?: string | null;
  archivedAt?: Date | null;
  agent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  total?: number;
  pending?: number;
  shared?: boolean;
  keysCount?: number;
  membersCount?: number;
}) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug ?? null,
    color: s.color ?? null,
    description: s.description ?? null,
    archived: !!s.archivedAt,
    agent: s.agent,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    online: Date.now() - new Date(s.lastSeenAt).getTime() < 2 * 60 * 1000,
    total: s.total ?? 0,
    shared: s.shared ?? false,
    pending: s.pending ?? 0,
    ...(s.keysCount !== undefined ? { keysCount: s.keysCount } : {}),
    ...(s.membersCount !== undefined ? { membersCount: s.membersCount } : {}),
  };
}

/**
 * When the caller is a channel (`ask`) key, restrict reads to what that key
 * created. Returns null for the account key or a paired device (full access).
 */
async function askScope(
  headers: Headers,
): Promise<{ keyId: string | null; sessionId: string | null } | null> {
  const raw = apiKeyFromHeaders(headers);
  if (!raw) return null;
  const auth = await findKeyAuth(raw);
  // Only `ask` keys are read-scoped. `approve` (account) and `manage` (secret)
  // keys see the whole account.
  if (!auth || auth.scope !== "ask") return null;
  return { keyId: auth.keyId, sessionId: auth.sessionId };
}

export const promptRoutes = new Elysia({ prefix: "/api/v1" })
  /** List prompts for the workspace, newest first. */
  .get(
    "/approvals",
    async ({ request, query }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const status =
        query.status === "pending" ||
        query.status === "approved" ||
        query.status === "denied" ||
        query.status === "expired"
          ? query.status
          : undefined;

      const scope = await askScope(request.headers);
      const options: ListPromptsOptions = {
        status,
        limit: query.limit,
        since: historyCutoff(getPlan(tenant.plan)),
      };
      if (scope) options.createdByKeyId = scope.keyId ?? "__none__";
      const prompts = await listPrompts(tenant.id, options);
      // Who approved: the account email when claimed, else the account key.
      const approver = approverOf(tenant);
      // The out-of-requests lock is resolved live against the current balance.
      const serialized = await serializeForApprover(prompts);
      return {
        prompts: serialized.map((p) => ({
          ...p,
          decidedBy: p.status === "pending" ? null : approver,
        })),
      };
    },
    {
      query: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal("pending"),
            t.Literal("approved"),
            t.Literal("denied"),
            t.Literal("expired"),
          ]),
        ),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })),
      }),
    },
  )

  /**
   * Fetch a prompt. Add `?wait=<seconds>` to long-poll: the request holds open
   * up to 55s for a decision, then returns the current state. This is the async
   * session an agent polls when it cannot (or must not) block.
   */
  .get(
    "/approvals/:id",
    async ({ request, params, query }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const scope = await askScope(request.headers);
      let prompt = await getPrompt(tenant.id, params.id);
      if (prompt && scope && prompt.createdByKeyId !== scope.keyId) prompt = null;
      if (!prompt) throw notFound("Prompt not found");

      const waitSeconds = query.wait ?? 0;
      if (waitSeconds > 0 && prompt.status === "pending") {
        const ms = Math.min(Math.max(waitSeconds, 1), 55) * 1000;
        const waiting = waitForDecision(prompt.id, tenant.id, ms);

        // Close the race: a decision may have landed between the read and attach.
        const current = await getPrompt(tenant.id, params.id);
        if (current && current.status !== "pending") {
          resolveWaiter(prompt.id, {
            approved: current.status === "approved",
            reason: current.reason,
            decision: current.decision,
            answer: current.answer,
            deviceId: current.deviceId,
            source: "pubsub",
          });
        }
        await waiting;
        prompt = (await getPrompt(tenant.id, params.id)) ?? prompt;
      }

      return {
        prompt: serializePrompt(prompt),
        approved: prompt.status === "approved",
        status: prompt.status,
        // Mirrored from the blocking response so a polling agent reads the same
        // shape: which route option the human took, and their own words when
        // they answered instead of deciding.
        decision: prompt.decision,
        answer: prompt.answer,
        route: prompt.route,
        pollUrl: `${env.publicBaseUrl}/api/v1/approvals/${prompt.id}`,
      };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      query: t.Object({
        wait: t.Optional(t.Number({ minimum: 0, maximum: 55 })),
      }),
    },
  )

  /** Cancel a pending prompt (the agent no longer needs the decision). */
  .post(
    "/approvals/:id/cancel",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const expired = await expirePrompt(tenant.id, params.id, "cancelled");

      if (!expired) {
        const existing = await getPrompt(tenant.id, params.id);
        if (!existing) throw notFound("Prompt not found");
        return { cancelled: false, prompt: serializePrompt(existing) };
      }

      // Wake any blocked/local waiter and tell devices it is gone.
      resolveWaiter(params.id, { approved: false, reason: "cancelled", source: "human" });
      await broadcastToWatchers(tenant.id, expired.sessionId, {
        type: "prompt.decided",
        promptId: params.id,
        approved: false,
        reason: "cancelled",
      });
      return { cancelled: true, prompt: serializePrompt(expired) };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /**
   * Decide a prompt over HTTP. The live path uses the WebSocket; this exists as
   * a reliable fallback for flaky mobile networks.
   */
  .post(
    "/approvals/:id/decision",
    async ({ request, params, body }) => {
      const { tenant, device } = await requireTenantOrDevice(request.headers);

      // The account must own the prompt or have the channel shared with it.
      const prompt = await getPromptAny(params.id);
      if (!prompt) throw notFound("Prompt not found");
      const allowed =
        prompt.tenantId === tenant.id ||
        (prompt.sessionId ? await canAccessChannel(tenant.id, prompt.sessionId) : false);
      if (!allowed) throw notFound("Prompt not found");

      const result = await recordDecision({
        promptId: params.id,
        tenantId: prompt.tenantId,
        approved: body.approved,
        reason: body.reason ?? null,
        decision: body.decision ?? null,
        answer: body.answer ?? null,
        deviceId: device?.id ?? null,
        // Lets every node fan the frame out to accounts the channel is shared with.
        sessionId: prompt.sessionId,
      });

      if (result.outcome === "blocked") {
        return {
          applied: false,
          outcome: "blocked",
          reason: result.message ?? "Out of requests",
          prompt: serializePrompt(prompt),
        };
      }

      if (result.outcome !== "applied") {
        const existing = await getPrompt(prompt.tenantId, params.id);
        if (!existing) throw notFound("Prompt not found");
        return {
          applied: false,
          reason: "Prompt was already decided",
          prompt: serializePrompt(existing),
        };
      }

      const updated = await getPrompt(prompt.tenantId, params.id);
      return { applied: true, prompt: updated ? serializePrompt(updated) : null };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Object({
        approved: t.Boolean(),
        reason: t.Optional(t.String({ maxLength: 500 })),
        /** For a batched route: the option id the human chose. */
        decision: t.Optional(t.String({ maxLength: 64 })),
        /**
         * The human's own words. Non-empty means the prompt is `answered`
         * rather than approved/denied (`approved` is then ignored).
         */
        answer: t.Optional(t.String({ maxLength: 2000 })),
      }),
    },
  )

  /** Send a non-blocking test approval to the workspace (used by the UI). */
  .post("/test", async ({ request }) => {
    const { tenant, device } = await requireTenantOrDevice(request.headers);

    const plan = getPlan(tenant.plan);
    const used =
      (await countAlerts(tenant.id, { since: usageSince(plan, tenant.claimedAt) })) *
      REQUESTS_PER_APPROVAL;
    const limit = checkLimit(plan, used, tenant.tokenBalance, undefined, env.publicBaseUrl);
    if (!limit.allowed) {
      throw paymentRequired(limit.message ?? "Limit reached", {
        plan: plan.id,
        used,
        limit: limit.limit,
        paymentUrl: topUpUrl(env.publicBaseUrl),
      });
    }
    if (limit.via === "token") await consumeTokens(tenant.id, REQUESTS_PER_APPROVAL);

    const prompt = await createPrompt({
      tenantId: tenant.id,
      title: "Test approval",
      message: "Notifications are working. Approve or deny to confirm.",
      kind: "test",
      agent: "psh test",
      metadata: { deviceId: device?.id ?? null },
      expiresInMs: 10 * 60 * 1000,
    });
    await broadcastToWatchers(tenant.id, prompt.sessionId, {
      type: "prompt.created",
      prompt: serializePrompt(prompt),
    });
    void sendPushToTenant(tenant.id, {
      title: prompt.title,
      body: prompt.message.slice(0, 160),
      tag: prompt.id,
      url: "/app",
      promptId: prompt.id,
    });
    return { prompt: serializePrompt(prompt) };
  })

  /** Register a connection (an agent/project) under the account. */
  .post(
    "/channels",
    async ({ request, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const connection = await createSession(tenant.id, body?.name, body?.agent ?? null);
      const { key } = await createApiKey(tenant.id, randomAgentName(), {
        scope: "ask",
        sessionId: connection.id,
      });
      const url = `${env.publicBaseUrl}/c/${connection.slug || connection.id}`;
      // Canonical #2 (join). #3 is docs only: nothing here may tell an installed
      // docs/prompt-templates.md, the client's channelPrompt() and join.html.
      const prompt = joinPrompt(url);
      return { connection: serializeSession(connection), key, url, prompt };
    },
    {
      body: t.Optional(
        t.Object({
          name: t.Optional(t.String({ maxLength: 120 })),
          agent: t.Optional(t.String({ maxLength: 120 })),
        }),
      ),
    },
  )

  /** List connections under the account, with key + member counts. */
  .get("/channels", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const scope = await askScope(request.headers);
    const rows = (await listSessions(tenant.id)).filter(
      (s) => !scope || s.id === scope.sessionId,
    );
    const connections = await Promise.all(
      rows.map(async (s) => {
        const [keysCount, inviteCount, shares] = await Promise.all([
          countChannelKeys(tenant.id, s.id),
          countChannelInvites(tenant.id, s.id),
          listChannelShares(tenant.id, s.id),
        ]);
        // owner + accepted shares + pending invites
        const membersCount = 1 + (shares?.length ?? 0) + inviteCount;
        return { ...serializeSession(s), keysCount, membersCount };
      }),
    );
    return { connections };
  })

  /** A connection and its requests (owned or shared with this account). */
  .get(
    "/channels/:id",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const connection = await getSessionById(params.id);
      if (!connection || !(await canAccessChannel(tenant.id, connection.id))) {
        throw notFound("Connection not found");
      }
      const scope = await askScope(request.headers);
      if (scope && connection.id !== scope.sessionId) throw notFound("Connection not found");
      const items = await listPrompts(connection.tenantId, {
        sessionId: connection.id,
        limit: 100,
        since: historyCutoff(getPlan(tenant.plan)),
      });
      // The channel owner is who approves - use their identity, not the viewer's.
      const owner = await getTenant(connection.tenantId);
      const approver = owner ? approverOf(owner) : null;
      // Affordability is the owner's, resolved live (see serializeForApprover).
      const serialized = await serializeForApprover(items);
      // The history names the agent, so it needs the key's *current* label - the
      // ask's own `agent` string is whatever the agent called itself at the time
      // and never changes when the human renames it.
      const keys = await listChannelKeys(connection.tenantId, connection.id);
      const keyNames = new Map(keys.map((k) => [k.id, k.name]));
      return {
        connection: serializeSession({ ...connection, shared: connection.tenantId !== tenant.id }),
        prompts: serialized.map((p) => ({
          ...p,
          decidedBy: p.status === "pending" ? null : approver,
          agentName: p.keyId ? (keyNames.get(p.keyId) ?? null) : null,
        })),
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /**
   * Invite a registered account to a channel, by email. Both sides must have
   * signed in with an email: an account is what makes a channel shareable.
   */
  .post(
    "/channels/:id/invites",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      if (!tenant.email) {
        throw forbidden("Sign in with your email to invite people.");
      }
      const email = body.email.trim().toLowerCase();
      const target = await findTenantByEmail(email);
      if (!target) {
        throw notFound("No psh.now account with that email yet - ask them to sign up first.");
      }
      if (target.id === tenant.id) throw badRequest("That's your own account.");
      const ok = await shareChannel(tenant.id, params.id, target.id);
      if (!ok) throw notFound("Channel not found");
      return { shared: true, channelId: params.id, email, accountId: target.id };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Object({ email: t.String({ format: "email", maxLength: 200 }) }),
    },
  )

  /**
   * The channel's invite link. No email, no delivery: the owner copies the link
   * from the share menu and sends it however they like. Whoever opens it signs
   * up and accepts it as an approver.
   */
  .get(
    "/channels/:id/invite-link",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const channel = await getSession(tenant.id, params.id);
      if (!channel) throw notFound("Channel not found");
      // The panel shows the link rather than a "create" button, so hand back
      // the live URL when we still hold its token (a row minted before tokens
      // were stored is retired here so the caller can mint a showable one).
      const active = await activeChannelInvite(tenant.id, params.id);
      if (active && !active.token) {
        await retireUnshowableInvite(tenant.id, params.id);
        return { active: false, url: null, expiresAt: null };
      }
      return {
        active: !!active,
        url: active?.token ? `${env.publicBaseUrl}/invite/${active.token}` : null,
        expiresAt: active?.expiresAt ?? null,
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  .post(
    "/channels/:id/invite-link",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const channel = await getSession(tenant.id, params.id);
      if (!channel) throw notFound("Channel not found");
      // One live link at a time: minting a new one retires the old link.
      await revokeChannelInvites(tenant.id, params.id);
      const invite = await createChannelInvite(tenant.id, params.id, null);
      return {
        invite: {
          id: invite.id,
          url: invite.url,
          expiresAt: invite.expiresAt,
        },
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  .delete(
    "/channels/:id/invite-link",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const revoked = await revokeChannelInvites(tenant.id, params.id);
      return { revoked };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** List a channel's shares + pending email invites. */
  .get(
    "/channels/:id/invites",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const [shares, invites] = await Promise.all([
        listChannelShares(tenant.id, params.id),
        listChannelInvites(tenant.id, params.id),
      ]);
      return {
        shares,
        invites: invites.map((i) => ({
          id: i.id,
          email: i.email,
          accepted: !!i.acceptedAt,
          declined: !!i.declinedAt,
          expiresAt: i.expiresAt,
        })),
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /**
   * Remove one pending invite - what the share panel's × does to an invite row.
   * (`DELETE …/invites/:accountId` below is the *other* direction: it takes away
   * an account that already joined.)
   */
  .post(
    "/channels/:id/invites/:inviteId/revoke",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const revoked = await revokeChannelInvite(tenant.id, params.id, params.inviteId);
      if (!revoked) throw notFound("Invite not found");
      return { revoked: true, id: params.inviteId, channelId: params.id };
    },
    {
      params: t.Object({
        id: t.String({ minLength: 4, maxLength: 32 }),
        inviteId: t.String({ minLength: 4, maxLength: 32 }),
      }),
    },
  )

  .delete(
    "/channels/:id/invites/:accountId",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const removed = await unshareChannel(tenant.id, params.id, params.accountId);
      return { unshared: removed, channelId: params.id, accountId: params.accountId };
    },
    {
      params: t.Object({
        id: t.String({ minLength: 4, maxLength: 32 }),
        accountId: t.String({ minLength: 4, maxLength: 32 }),
      }),
    },
  )

  .delete(
    "/channels/:id",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const deleted = await deleteSession(tenant.id, params.id);
      if (!deleted) throw notFound("Connection not found");
      return { deleted: true, id: params.id };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /**
   * Rename a channel or set its description. The public URL is **not** editable:
   * it is minted once (16 random characters) and the link is what agents attach
   * with, so moving it orphans every connected agent.
   */
  .patch(
    "/channels/:id",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      if (body.slug !== undefined) {
        throw badRequest(
          "A channel's URL is permanent - it was minted when the channel was created.",
        );
      }
      const updated = await updateSession(tenant.id, params.id, {
        name: body.name,
        description: body.description,
        color: body.color,
      });
      if (!updated) throw notFound("Channel not found");
      return { connection: serializeSession(updated) };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Object({
        name: t.Optional(t.String({ maxLength: 120 })),
        description: t.Optional(t.String({ maxLength: 400 })),
        slug: t.Optional(t.String({ maxLength: 40 })),
        color: t.Optional(t.String({ maxLength: 20 })),
      }),
    },
  )

  /** Archive (or restore) a channel. */
  .post(
    "/channels/:id/archive",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const updated = await setSessionArchived(tenant.id, params.id, body?.archived ?? true);
      if (!updated) throw notFound("Channel not found");
      return { connection: serializeSession(updated) };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Optional(t.Object({ archived: t.Optional(t.Boolean()) })),
    },
  )

  /**
   * Trade the account key for a download URL.
   *
   * The browser cannot carry a header on a download, so the CSV arrives by
   * navigating to a signed URL instead; this is the press that mints it.
   */
  .post(
    "/channels/:id/export",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const connection = await getSessionById(params.id);
      if (!connection || !(await canAccessChannel(tenant.id, connection.id))) {
        throw notFound("Channel not found");
      }
      const scope = await askScope(request.headers);
      if (scope && connection.id !== scope.sessionId) throw notFound("Channel not found");

      // Counted now so an empty channel says so, rather than downloading a
      // header row and leaving the person to open it to find out.
      const count = await countChannelExport(connection, tenant.id);
      return { url: `/api/v1/export/${signExportToken(connection.id, tenant.id)}`, count };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /**
   * The CSV itself. Unauthenticated by design: the signed token is the
   * credential, and access is checked again here, so a share revoked a second
   * after the press stops working immediately rather than at token expiry.
   */
  .get(
    "/export/:token",
    async ({ params }) => {
      const { channelId, tenantId } = verifyExportToken(params.token);
      const connection = await getSessionById(channelId);
      const viewer = await getTenant(tenantId);
      if (!connection || !viewer || !(await canAccessChannel(tenantId, connection.id))) {
        throw notFound("Channel not found");
      }
      const { filename, csv } = await buildChannelExport(connection, tenantId);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          // History changes with every decision; a cached copy would go stale silently.
          "cache-control": "no-store",
        },
      });
    },
    { params: t.Object({ token: t.String({ minLength: 16, maxLength: 4096 }) }) },
  )

  /** Agent keys bound to this channel. */
  .get(
    "/channels/:id/keys",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const scope = await askScope(request.headers);
      if (scope && scope.sessionId !== params.id) throw notFound("Channel not found");
      const keys = await listChannelKeys(tenant.id, params.id);
      return {
        keys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
          revealable: !!k.keyEnc,
        })),
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** Create a channel key (routes requests to this channel by default). */
  .post(
    "/channels/:id/keys",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const { key, record } = await createApiKey(tenant.id, body?.name || randomAgentName(), {
        scope: "ask",
        sessionId: params.id,
      });
      return {
        key,
        id: record.id,
        name: record.name,
        prefix: record.prefix,
        warning: "Store this key now. It will not be shown again.",
      };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Optional(t.Object({ name: t.Optional(t.String({ maxLength: 60 })) })),
    },
  )

  /** Rename a channel key (cosmetic) - what the share panel's pencil saves. */
  .patch(
    "/channels/:id/keys/:keyId",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const keys = await listChannelKeys(tenant.id, params.id);
      if (!keys.some((k) => k.id === params.keyId)) throw notFound("Key not found");
      const key = await renameApiKey(tenant.id, params.keyId, body.name);
      if (!key) throw notFound("Key not found");
      return { id: key.id, name: key.name };
    },
    {
      params: t.Object({
        id: t.String({ minLength: 4, maxLength: 32 }),
        keyId: t.String({ minLength: 4, maxLength: 32 }),
      }),
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 60 }) }),
    },
  )

  /** Revoke a channel key. */
  .delete(
    "/channels/:id/keys/:keyId",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const revoked = await revokeApiKey(tenant.id, params.keyId);
      return { revoked, id: params.keyId };
    },
    {
      params: t.Object({
        id: t.String({ minLength: 4, maxLength: 32 }),
        keyId: t.String({ minLength: 4, maxLength: 32 }),
      }),
    },
  )

  /** One-time link that connects an agent to THIS channel (ask-only key). */
  .post(
    "/channels/:id/join-link",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const channel = await getSessionById(params.id);
      if (!channel || channel.tenantId !== tenant.id) throw notFound("Channel not found");
      return {
        channelId: params.id,
        channelName: channel.name,
        url: `${env.publicBaseUrl}/c/${channel.slug || channel.id}`,
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** People who can approve this channel: owner, shared accounts, invites. */
  .get(
    "/channels/:id/members",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const scope = await askScope(request.headers);
      if (scope && scope.sessionId !== params.id) throw notFound("Channel not found");
      const channel = await getSessionById(params.id);
      if (!channel) throw notFound("Channel not found");
      const [shares, invites] = await Promise.all([
        listChannelShares(tenant.id, params.id),
        listChannelInvites(tenant.id, params.id),
      ]);
      return {
        members: [
          { id: channel.tenantId, role: "owner", accountId: channel.tenantId },
          ...shares.map((s) => ({ id: s.sharedWith, role: "approver", accountId: s.sharedWith })),
          ...invites.map((i) => ({
            id: i.id,
            role: "invited",
            email: i.email,
            // An invite with no email is the channel's own link.
            link: !i.email,
            pending: !i.acceptedAt && !i.revokedAt && i.expiresAt.getTime() > Date.now(),
            revoked: !!i.revokedAt,
            expired: i.expiresAt.getTime() <= Date.now(),
            acceptedBy: i.acceptedBy ?? null,
            expiresAt: i.expiresAt,
          })),
        ],
      };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** List paired supervisor devices. */
  .get("/devices", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const devices = await listDevices(tenant.id);
    const online = onlineDeviceIds(tenant.id);
    return {
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        revokedAt: d.revokedAt,
        online: online.has(d.id),
        // Enough to describe the device on the Devices page without a second call.
        userAgent: d.userAgent,
        ip: d.ip,
        country: d.country,
      })),
    };
  })

  /** Revoke a paired device. */
  .delete(
    "/devices/:id",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const revoked = await revokeDevice(tenant.id, params.id);
      if (!revoked) throw notFound("Device not found");
      return { revoked: true, id: params.id };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** Rename a paired device (cosmetic). */
  .patch(
    "/devices/:id",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const device = await renameDevice(tenant.id, params.id, body.name);
      if (!device) throw notFound("Device not found");
      return { id: device.id, name: device.name };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 60 }) }),
    },
  );
