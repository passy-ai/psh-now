import { Elysia, t } from "elysia";
import QRCode from "qrcode";
import {
  consumePairing,
  createPairing,
  listDevices,
} from "../services/devices";
import {
  addTokens,
  directGrantsUsed,
  claimFreeTopUp,
  recordFreeTopUp,
  adoptWorkspace,
  claimTenant,
  createSecretKey,
  createTenant,
  findKeyAuth,
  findTenantByEmail,
  getTenant,
  revealAccountKey,
  revealSecretKey,
  rotateTenantKeys,
} from "../services/tenants";
import { peekChannelUrl, redeemChannelUrl } from "../services/join";
import { peekInvite, redeemInviteToken } from "../services/invites";
import { requireTenant, requireTenantOrDevice } from "../lib/tenant-auth";
import { billingConfigured } from "../services/billing";
import { mailConfigured, sendClaimCodeEmail } from "../services/mail";
import { isLocalRequest } from "../lib/plans";
import { clientOrigin } from "../lib/client";
import { HttpError, badRequest, conflict, forbidden, gone, notFound, unauthorized } from "../lib/http";
import {
  checkLimit,
  getPlan,
  usageSince,
  REQUESTS_PER_APPROVAL,
  TOKEN_PACKAGES,
  TOPUP_REQUESTS,
  TOPUP_LIMIT_ANON,
  TOPUP_LIMIT_CLAIMED,
  topUpLimit,
  pickTokenPackage,
} from "../lib/plans";
import { env } from "../env";
import { db } from "../db";
import { auditLog } from "../db/schema";
import { pairingTokens, sessions } from "../db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiKeyFromHeaders, sha256 } from "../lib/crypto";
import { countAlerts, countPending } from "../services/prompts";
import { createApiKey, listApiKeys, randomAgentName, renameApiKey, revealApiKey, revokeApiKey } from "../services/keys";
import { createSession, getSessionById } from "../services/sessions";
import { createClaim, verifyClaim, verifyClaimByEmail } from "../services/claims";
import { onlineDeviceCount } from "../lib/realtime";

/** Rendered QR codes, keyed by their payload. Bounded: these are URLs, not data. */
const qrCache = new Map<string, string>();

export const authRoutes = new Elysia({ prefix: "/api/v1" })
  /**
   * Create a workspace/channel. Used by `psh init` and by agents provisioning
   * themselves. Pass `pair: true` to also get a pairing link + QR in one call,
   * so an agent can hand a human a single thing to open.
   * Returns the API key exactly once - it is never retrievable again.
   */
  .post(
    "/channels",
    async ({ body }) => {
      const { tenant, apiKey } = await createTenant(body?.name);

      const pairing = body?.pair
        ? await createPairing(tenant.id)
        : null;

      return {
        workspace: {
          id: tenant.id,
          name: tenant.name,
          createdAt: tenant.createdAt,
          plan: tenant.plan,
          /** Unclaimed workspaces expire; claim with an email to keep it. */
          expiresAt: tenant.expiresAt,
          claimed: false,
        },
        apiKey,
        apiKeyPrefix: tenant.apiKeyPrefix,
        ...(pairing
          ? {
              pairing: {
                url: pairing.url,
                token: pairing.token,
                qrUrl: `${env.publicBaseUrl}/api/v1/qr?data=${encodeURIComponent(pairing.url)}`,
                expiresAt: pairing.expiresAt,
              },
            }
          : {}),
        warning: "Store this API key securely. It will not be shown again.",
      };
    },
    {
      body: t.Optional(
        t.Object({
          name: t.Optional(t.String({ maxLength: 120 })),
          pair: t.Optional(t.Boolean()),
        }),
      ),
    },
  )

  /**
   * Mint an anonymous workspace + key with no input. The zero-friction path:
   * returns a user key (app login) and a channel key (the agent's key).
   */
  .post("/mint", async () => {
    const { tenant, apiKey: userKey } = await createTenant("Anonymous");
    // A real "Default" channel, so the install report can hand out a concrete
    // connect prompt. The key is bound to it, so the test request lands there.
    const channel = await createSession(tenant.id, "Default");
    const { key: channelKey } = await createApiKey(tenant.id, randomAgentName(), {
      scope: "ask",
      sessionId: channel.id,
    });
    return {
      userKey,
      channelKey,
      /** Convenience: the key an agent should send. */
      apiKey: channelKey,
      channelName: channel.name,
      channelUrl: `${env.publicBaseUrl}/c/${channel.slug || channel.id}`,
      workspaceId: tenant.id,
      plan: tenant.plan,
      appUrl: `${env.publicBaseUrl}/app`,
      /** Open the dashboard without signing in: the key rides in the fragment. */
      accessUrl: `${env.publicBaseUrl}/app#key=${userKey}`,
      /** Claim it (register) for more requests. */
      claimUrl: `${env.publicBaseUrl}/claim#key=${userKey}`,
      expiresAt: tenant.expiresAt,
      note: "userKey signs in and approves; channelKey is what the agent sends. Create the admin secret in the dashboard.",
    };
  })

  /**
   * Take a freshly minted anonymous workspace into this account.
   *
   * A new project's install mints its own anonymous workspace; when the human
   * - already signed in - opens that install's link, the agent's channel and
   * its pending questions move here instead of stranding the install in a
   * second, invisible account. The agent keeps working with the same key.
   */
  .post(
    "/me/adopt",
    async ({ request, body }) => {
      const tenant = await requireTenant(request.headers);
      const result = await adoptWorkspace(tenant.id, body.key.trim());
      if (!result.ok) {
        const message: Record<string, string> = {
          "not-found": "That link's account no longer exists",
          "same-account": "That workspace is already this account",
          claimed: "That workspace belongs to a registered account - sign in there instead",
          "not-anonymous": "That workspace is not an anonymous install",
          "too-old": "That workspace is not a fresh install - use ?switch=1 to open it separately",
          "has-devices": "That workspace already has a paired device of its own",
          "too-busy": "That workspace is already in use - use ?switch=1 to open it separately",
          "no-agent-key": "That workspace has no agent key to move",
        };
        throw badRequest(message[result.reason] ?? "That workspace cannot be added");
      }
      console.log(
        `psh.now: adopted workspace ${result.workspaceId} into ${tenant.id} (${result.channelsMoved} channel key(s), ${result.requestsMoved} request(s))`,
      );
      return {
        ok: true,
        workspaceId: result.workspaceId,
        channelsMoved: result.channelsMoved,
        requestsMoved: result.requestsMoved,
      };
    },
    { body: t.Object({ key: t.String({ minLength: 8, maxLength: 200 }) }) },
  )

  /**
   * Ensure the account SECRET key (manage) exists, and hand it back. Every
   * account is now minted with one, so this normally just reveals it; it only
   * creates a key for accounts made before that change. Dashboard-only - never
   * surfaced through an agent's install output.
   */
  .post("/me/secret", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const secretKey = tenant.secretKeyHash
      ? await revealSecretKey(tenant.id)
      : await createSecretKey(tenant.id);
    if (!secretKey) throw notFound("No recoverable secret key for this account");
    return {
      secretKey,
      warning: "Store this now; it is not shown again. It administers the account.",
    };
  })

  /** Reveal the secret key again (approve scope) so the owner can copy it. */
  .post("/me/secret/reveal", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const secretKey = await revealSecretKey(tenant.id);
    if (!secretKey) throw notFound("No recoverable secret key for this account");
    return { secretKey };
  })

  /**
   * Rotate the account key + secret. The recovery path when a key leaks.
   * Requires the current secret (manage scope).
   */
  .post("/me/rotate", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const rotated = await rotateTenantKeys(tenant.id);
    if (!rotated) throw notFound("Account not found");
    return {
      userKey: rotated.apiKey,
      secretKey: rotated.secretKey,
      accessUrl: `${env.publicBaseUrl}/app#key=${rotated.apiKey}`,
      warning: "Old keys are now invalid. Store the new ones; they are not shown again.",
    };
  })

  /**
   * Public: redeem a join link for a channel key on the same account. This is
   * how a second agent/machine ends up on the SAME account while anonymous.
   */
  /**
   * Is this join/connect link still usable? Read-only - the join page checks it
   * so a used or expired link says so, instead of the agent hitting a bare 410
   * halfway through a task.
   */
  .get("/join/:token", async ({ params }) => {
    const alive = (await peekInvite(params.token)) || (await peekChannelUrl(params.token));
    if (!alive) throw gone("That connect link is no longer usable");
    return { valid: true };
  })

  .post(
    "/join/:token",
    async ({ params }) => {
      // Two kinds of link land here: an invite link (the /invite/<token> one -
      // ask-only, reusable while it is live) and a channel URL (/c/<slug>,
      // reusable for as long as the channel exists). Each resolves to a fresh
      // requester key.
      const redeemed =
        (await redeemInviteToken(params.token)) ?? (await redeemChannelUrl(params.token));
      if (!redeemed) throw gone("Invalid, expired, or already-used link");
      return {
        channelKey: redeemed.channelKey,
        apiKey: redeemed.channelKey,
        workspaceId: redeemed.tenantId,
        channelName: redeemed.channelName,
        channelUrl: redeemed.channelUrl,
        appUrl: `${env.publicBaseUrl}/app`,
        host: env.publicBaseUrl,
        note: "channelKey joins the SAME account as the link creator. Save it; ask-only.",
      };
    },
    { params: t.Object({ token: t.String({ minLength: 4, maxLength: 64 }) }) },
  )

  /** Request a claim code for the workspace (sent to email in production). */
  .post(
    "/me/register",
    async ({ request, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const claim = await createClaim(tenant.id, body.email, {
        firstName: body.firstName,
        lastName: body.lastName,
      });
      /**
       * The code has to reach a human, and the response body is not a mailbox: it is
       * whatever is on their screen. On a public host the code is emailed, and an
       * instance that cannot send email says so instead of answering 200 with a code
       * only the browser ever saw. Only a request from this machine gets the code back.
       */
      const local = isLocalRequest(request);
      if (!local) {
        if (!mailConfigured()) {
          throw new HttpError(
            503,
            "This instance cannot send email yet, so no claim code can be delivered: set " +
              "SMTP_URL and MAIL_FROM, or RESEND_API_KEY and MAIL_FROM.",
            "mail_unconfigured",
          );
        }
        try {
          await sendClaimCodeEmail({
            to: claim.email,
            code: claim.code,
            minutes: Math.round(env.claimTtlMs / 60_000),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Email delivery failed";
          console.error("[claim] send failed:", message);
          throw new HttpError(502, `Could not send the code: ${message}`, "upstream");
        }
      }
      return {
        claimId: claim.id,
        email: claim.email,
        expiresAt: claim.expiresAt,
        /** Local only: a code in a response is a code on a screen. */
        ...(local && env.devClaim ? { code: claim.code } : {}),
        message:
          local && env.devClaim
            ? "Dev mode: use `code` to verify."
            : `We emailed a code to ${claim.email}. It can be resent.`,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email", maxLength: 200 }),
        firstName: t.Optional(t.String({ maxLength: 80 })),
        lastName: t.Optional(t.String({ maxLength: 80 })),
      }),
    },
  )

  /** Verify a claim code and make the workspace permanent. */
  .post(
    "/me/register/verify",
    async ({ body }) => {
      const claim = await verifyClaim(body.claimId, body.code);
      if (!claim) throw gone("Invalid, expired, or already-used claim code");
      return {
        registered: true,
        email: claim.email,
        firstName: claim.firstName,
        lastName: claim.lastName,
        workspaceId: claim.tenantId,
      };
    },
    {
      body: t.Object({
        claimId: t.String({ minLength: 4, maxLength: 32 }),
        code: t.String({ minLength: 4, maxLength: 12 }),
      }),
    },
  )

  /** Issue a pairing token + QR URL. Accepted from an API key or a paired device. */
  .post("/devices/pairing", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const pairing = await createPairing(tenant.id);
    return {
      workspaceId: tenant.id,
      url: pairing.url,
      token: pairing.token,
      qrUrl: `${env.publicBaseUrl}/api/v1/qr?data=${encodeURIComponent(pairing.url)}`,
      expiresAt: pairing.expiresAt,
    };
  })

  /** Public: render any string as an SVG QR code for the pairing UI. */
  .get(
    "/qr",
    async ({ query }) => {
      /**
       * Rendering the SVG is pure CPU and the deployed host takes the better part of a
       * second over it, while the dashboard asks for the same pairing code from the
       * modal and from every channel card. One render per distinct string.
       */
      let svg = qrCache.get(query.data);
      if (!svg) {
        svg = await QRCode.toString(query.data, {
          type: "svg",
          margin: 1,
          width: 240,
          color: { dark: "#0b0d12", light: "#ffffff" },
        });
        if (qrCache.size >= 200) {
          const oldest = qrCache.keys().next().value;
          if (oldest !== undefined) qrCache.delete(oldest);
        }
        qrCache.set(query.data, svg);
      }
      return new Response(svg, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "private, max-age=600",
        },
      });
    },
    { query: t.Object({ data: t.String({ minLength: 1, maxLength: 2048 }) }) },
  )

  /** Public: validate a pairing token before the phone claims it. */
  .get(
    "/pairing/:token",
    async ({ params }) => {
      const tokenHash = sha256(params.token);
      const [row] = await db
        .select({
          id: pairingTokens.id,
          tenantId: pairingTokens.tenantId,
          expiresAt: pairingTokens.expiresAt,
        })
        .from(pairingTokens)
        .where(
          and(
            eq(pairingTokens.tokenHash, tokenHash),
            isNull(pairingTokens.consumedAt),
            gt(pairingTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (!row) throw gone("This pairing link is invalid, expired or already used");
      // Give the pair page enough to say *who* is inviting and where.
      const owner = await getTenant(row.tenantId);
      const ownerName =
        [owner?.firstName, owner?.lastName].filter(Boolean).join(" ").trim() ||
        owner?.email ||
        null;
      const [defaultChannel] = await db
        .select({ name: sessions.name })
        .from(sessions)
        .where(eq(sessions.tenantId, row.tenantId))
        .limit(1);
      return {
        valid: true,
        workspaceId: row.tenantId,
        workspaceName: owner?.name ?? null,
        ownerName,
        channelName: defaultChannel?.name ?? null,
        expiresAt: row.expiresAt,
      };
    },
    { params: t.Object({ token: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  /** Public: the phone exchanges a pairing token for a long-lived device token. */
  .post(
    "/pairing/:token/claim",
    async ({ params, body, request }) => {
      const userAgent = request.headers.get("user-agent");
      const paired = await consumePairing({
        token: params.token,
        deviceName: body?.name,
        userAgent,
        ...clientOrigin(request.headers),
      });

      if (!paired) throw gone("This pairing link is invalid, expired or already used");

      return {
        workspaceId: paired.device.tenantId,
        device: {
          id: paired.device.id,
          name: paired.device.name,
          pairedAt: paired.device.pairedAt,
        },
        deviceToken: paired.deviceToken,
        wsUrl: `${env.publicBaseUrl.replace(/^http/, "ws")}/ws`,
      };
    },
    {
      params: t.Object({ token: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Optional(t.Object({ name: t.Optional(t.String({ maxLength: 120 })) })),
    },
  )

  /** Authenticated workspace overview for dashboards. */
  .get("/me", async ({ request }) => {
    const tenant = await requireTenant(request.headers);
    // A channel key is bound to one channel, and a key-based install has no join response to
    // read that channel from: without this, `.psh/keys.json` carried no channelUrl and the
    // install report's prompt fell back to a `<channel-link>` placeholder (found in the Docker
    // four-step run, 2026-10-17). An account key has no session, so this stays null there.
    const keyAuth = await findKeyAuth(apiKeyFromHeaders(request.headers) ?? "");
    const channel = keyAuth?.sessionId ? await getSessionById(keyAuth.sessionId) : null;
    const plan = getPlan(tenant.plan);
    const [devices, pending, alerts] = await Promise.all([
      listDevices(tenant.id),
      countPending(tenant.id),
      countAlerts(tenant.id, { since: usageSince(plan, tenant.claimedAt) }),
    ]);
    const used = alerts * REQUESTS_PER_APPROVAL;
    const limit = checkLimit(plan, used, tenant.tokenBalance);
    /**
     * While no provider is approved the packs are free, so the allowance decides what
     * can be offered: a 10,000 pack the account could never take is a button that only
     * ever produces a refusal.
     */
    const livePayments = billingConfigured();
    const freeLeft = livePayments
      ? 0
      : Math.max(0, env.directTokensMax - (await directGrantsUsed(tenant.id)));
    return {
      /**
       * What can be bought, so no surface has to hardcode a price. With a live
       * provider these are the packs that have a product id; without one the same
       * packs are given away, which is why they carry `free`: a surface must label
       * them honestly instead of showing a price it cannot charge.
       */
      packs: TOKEN_PACKAGES.filter((p) =>
        livePayments ? p.priceEur > 0 : p.requests <= freeLeft,
      ).map((p) => ({
        id: p.id,
        requests: p.requests,
        priceEur: p.priceEur,
        free: !livePayments,
      })),
      /** Free requests still available on this workspace; null once money is live. */
      directRemaining: livePayments ? null : freeLeft,
      workspace: {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
        email: tenant.email,
        firstName: tenant.firstName,
        lastName: tenant.lastName,
        claimed: !!tenant.claimedAt,
        hasSecret: !!tenant.secretKeyHash,
        secretKeyPrefix: tenant.secretKeyPrefix,
        hasSecretReveal: !!tenant.secretKeyEnc,
        /** Public host - clients build shareable prompts/links from this. */
        baseUrl: env.publicBaseUrl,
        /** True outside production: shows the test-only helpers in the UI. */
        dev: env.devClaim,
        expiresAt: tenant.expiresAt,
        plan: tenant.plan,
        tokenBalance: tenant.tokenBalance,
        /**
         * How many free +20 top-ups are left. The dashboard uses it to decide
         * whether the top-up button does anything; it is never rendered as a
         * countdown, because the mechanic is meant to be found by running out,
         * not advertised.
         */
        freeTopUpsLeft: Math.max(0, topUpLimit(!!tenant.claimedAt) - tenant.freeTopUps),
      },
      /** The channel this key routes to - null for the account key. */
      channelName: channel?.name ?? null,
      channelUrl: channel ? `${env.publicBaseUrl}/c/${channel.slug || channel.id}` : null,
      usage: {
        plan: plan.id,
        requestsToday: used,
        // The ceiling is the free allowance **plus** whatever was prepaid, so
        // the bar climbs to 100% exactly where `checkLimit()` blocks: buying
        // credits does not shrink the percentage into nonsense (used+balance
        // gave "60/1060"), and the allowance is never hidden by a balance.
        limit:
          plan.requestsTotal != null
            ? plan.requestsTotal + tenant.tokenBalance
            : tenant.tokenBalance > 0
              ? tenant.tokenBalance + used
              : limit.limit,
        via: limit.via,
        tokenBalance: tenant.tokenBalance,
      },
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        revokedAt: d.revokedAt,
      })),
      pendingPrompts: pending,
      onlineDevices: onlineDeviceCount(tenant.id),
    };
  })

  /**
   * The free top-up: 20 requests, no card, no checkout, no visible price.
   *
   * Denominations are deliberately odd (twenty, not the hundred of a pack) so the
   * balance itself records how it got there. A workspace may take it once while
   * anonymous and twenty times in total once claimed; the counter is shared, so
   * claiming does not hand out a second allowance.
   *
   * Refusals are 409 with the real numbers rather than a silent no-op: this is the
   * one free path in the product, and "it stopped working" with no reason is how a
   * legitimately out-of-requests human concludes the product is broken.
   */
  .post("/me/tokens/free", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const claimed = !!tenant.claimedAt;
    const limit = topUpLimit(claimed);
    const { granted, balance, taken } = await claimFreeTopUp(
      tenant.id,
      TOPUP_REQUESTS,
      TOPUP_LIMIT_ANON,
      TOPUP_LIMIT_CLAIMED,
    );
    if (!granted) {
      throw conflict(
        claimed
          ? `All ${limit} free top-ups have been taken on this account`
          : `The free top-up has already been taken once. Register this workspace for ${TOPUP_LIMIT_CLAIMED} in total.`,
      );
    }
    await recordFreeTopUp(tenant.id, TOPUP_REQUESTS, taken, limit, balance, claimed);
    return {
      added: TOPUP_REQUESTS,
      tokenBalance: balance,
      /** How many of the ceiling are now used, so the dashboard can stop offering it. */
      freeTopUps: taken,
      freeTopUpLimit: limit,
      freeTopUpsLeft: Math.max(0, limit - taken),
    };
  })

/** Public health probe. */
  .get("/health", () => ({ ok: true, ts: new Date().toISOString() }))

  /**
   * Add a prepaid token package. In production this is triggered by the billing
   * provider's webhook; in dev mode it is callable directly for testing.
   */
  .post(
    "/me/tokens",
    async ({ request, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      /**
       * Refused only when a checkout can actually be created. While no payment provider
       * is approved there is nothing to redirect to, so a 403 here was a dead end: the
       * browser fell through to /billing/checkout, which answered "not configured".
       */
      if (!env.devClaim && billingConfigured()) {
        throw forbidden("Token purchases are handled by the billing provider");
      }
      // The pack is the caller's choice. This used to ignore it and always grant, and
      // bill, the one pack, so 100 requests cost the same invoice as 10,000.
      const pack = pickTokenPackage(body?.requests);
      if (!pack) throw badRequest("Unknown request pack");
      /**
       * No provider means no money to collect, so the pack settles immediately - the
       * button does what it says instead of opening a checkout that does not exist.
       * Capped per workspace, because "checkout is not live" must not read as unlimited
       * free capacity. Dev keeps its uncapped path, since that is what it is for.
       */
      const direct = !env.devClaim;
      let used = 0;
      if (direct) {
        used = await directGrantsUsed(tenant.id);
        if (used + pack.requests > env.directTokensMax) {
          throw forbidden(
            `Payments are not live yet, so requests are free while they are not: ` +
              `${env.directTokensMax.toLocaleString()} per workspace, ${used.toLocaleString()} taken.`,
          );
        }
      }
      const tokenBalance = await addTokens(tenant.id, pack.requests);
      if (direct) {
        await db.insert(auditLog).values({
          tenantId: tenant.id,
          action: "tokens.direct",
          detail: {
            requests: pack.requests,
            priceEur: pack.priceEur,
            reason: "no-payment-provider",
          },
        });
      }
      // VAT: reverse charge (0%) when a VAT number is given, else 21%.
      const reverseCharge = !!body?.vatNumber;
      const net = pack.priceEur;
      const vat = reverseCharge ? 0 : Math.round(net * 0.21 * 100) / 100;
      return {
        added: pack.requests,
        tokenBalance,
        /** True when the pack was granted here, not paid for at a provider. */
        direct,
        directRemaining: direct ? Math.max(0, env.directTokensMax - used - pack.requests) : null,
        // Reported for convenience only: the purchase never changes the plan.
        plan: tenant.plan,
        /**
         * No money moved, so there is no invoice to show. Printing €9 net plus VAT for
         * a pack that was granted here would be a receipt for a payment nobody made.
         */
        invoice: direct ? null : {
          companyName: body?.companyName ?? null,
          vatNumber: body?.vatNumber ?? null,
          country: body?.country ?? null,
          net,
          vat,
          total: Math.round((net + vat) * 100) / 100,
          currency: "EUR",
          reverseCharge,
        },
      };
    },
    {
      body: t.Optional(
        t.Object({
          requests: t.Optional(t.Number({ minimum: 1, maximum: 10_000_000 })),
          companyName: t.Optional(t.String({ maxLength: 200 })),
          vatNumber: t.Optional(t.String({ maxLength: 40 })),
          country: t.Optional(t.String({ maxLength: 80 })),
        }),
      ),
    },
  )

  /**
   * Agent API keys. A paired device (or an existing key) can mint a new one -
   * this is how a user recovers a key they did not save. The raw key is
   * returned once; only its hash is stored.
   */
  .post(
    "/me/keys",
    async ({ request, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const { key, record } = await createApiKey(tenant.id, body?.name || randomAgentName());
      return {
        key,
        id: record.id,
        name: record.name,
        prefix: record.prefix,
        createdAt: record.createdAt,
        warning: "Store this key now. It will not be shown again.",
      };
    },
    { body: t.Optional(t.Object({ name: t.Optional(t.String({ maxLength: 60 })) })) },
  )

  .get("/me/keys", async ({ request }) => {
    const { tenant } = await requireTenantOrDevice(request.headers);
    const keys = await listApiKeys(tenant.id);
    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
        /** True when the raw key can be revealed to this operator. */
        revealable: !!k.keyEnc,
      })),
    };
  })

  /** Rename an agent key (cosmetic). */
  .patch(
    "/me/keys/:id",
    async ({ request, params, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const key = await renameApiKey(tenant.id, params.id, body.name);
      if (!key) throw notFound("Key not found");
      return { id: key.id, name: key.name };
    },
    {
      params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }),
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 60 }) }),
    },
  )

  /** Reveal a key's raw value to the authenticated operator (device or key). */
  .get(
    "/me/keys/:id/reveal",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const key = await revealApiKey(tenant.id, params.id);
      if (!key) {
        throw notFound(
          "This key cannot be revealed. Create a new agent key and it will be recoverable.",
        );
      }
      return { id: params.id, key };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  )

  .delete(
    "/me/keys/:id",
    async ({ request, params }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      const revoked = await revokeApiKey(tenant.id, params.id);
      return { revoked, id: params.id };
    },
    { params: t.Object({ id: t.String({ minLength: 4, maxLength: 32 }) }) },
  );

/**
 * Agent sign-in (here.now style). An agent requests a code for the user's
 * email; the user pastes it back; the agent receives a channel key on the
 * account that email owns (created if new). This is how a new machine joins the
 * same account with no pasted secret.
 */
export const agentAuthRoutes = new Elysia({ prefix: "/api/auth" })
  .post(
    "/agent/request-code",
    async ({ body }) => {
      const email = body.email.trim().toLowerCase();
      let tenant = await findTenantByEmail(email);
      if (!tenant) {
        const created = await createTenant("Registered");
        tenant =
          (await claimTenant(created.tenant.id, email, {
            firstName: body.firstName,
            lastName: body.lastName,
          })) ?? created.tenant;
      }
      const claim = await createClaim(tenant.id, email, {
        firstName: body.firstName,
        lastName: body.lastName,
      });
      return {
        email,
        claimId: claim.id,
        expiresAt: claim.expiresAt,
        ...(env.devClaim ? { code: claim.code } : {}),
        message: env.devClaim
          ? "Dev mode: use `code` to verify."
          : "Check your inbox for a sign-in code.",
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email", maxLength: 200 }),
        firstName: t.Optional(t.String({ maxLength: 80 })),
        lastName: t.Optional(t.String({ maxLength: 80 })),
      }),
    },
  )
  .post(
    "/agent/verify-code",
    async ({ body }) => {
      const claim = await verifyClaimByEmail(body.email, body.code);
      if (!claim) throw gone("Invalid, expired, or already-used code");
      const { key } = await createApiKey(claim.tenantId, "Agent sign-in");
      return {
        apiKey: key,
        channelKey: key,
        workspaceId: claim.tenantId,
        email: claim.email,
        host: env.publicBaseUrl,
        note: "channelKey signs this agent in to the account for that email. Save it.",
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email", maxLength: 200 }),
        code: t.String({ minLength: 4, maxLength: 12 }),
      }),
    },
  );
