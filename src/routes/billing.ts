import { Elysia, t } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLog, tenants } from "../db/schema";
import { HttpError, badRequest, forbidden, notFound } from "../lib/http";
import { requireTenantOrDevice } from "../lib/tenant-auth";
import { TEST_PACK_ID, TOKEN_PACKAGES, pickTokenPackage } from "../lib/plans";
import { addTokens } from "../services/tenants";
import {
  billingConfigured,
  billingMode,
  createCheckout,
  parsePaidEvent,
  productFor,
  verifyWebhook,
} from "../services/billing";

/**
 * Payments. Nothing here holds card data: the browser is sent to a hosted checkout
 * and the only thing that grants tokens is a signed webhook. The redirect back is
 * never trusted, because it is a URL the user controls.
 */
export const billingRoutes = new Elysia({ prefix: "/api/v1" })
  /**
   * What can be bought, in money, as packs. No per-request arithmetic anywhere.
   * With no provider approved the list is not empty and the packs are not for sale:
   * they are granted directly, and `free` says so, because an empty list is what made
   * the buy button look broken.
   */
  .get("/billing/status", () => {
    const live = billingConfigured();
    return {
      mode: billingMode(),
      free: !live,
      packs: TOKEN_PACKAGES.filter((p) =>
        live ? p.priceEur > 0 && productFor(p.requests) : p.id !== TEST_PACK_ID,
      ).map((p) => ({
        requests: p.requests,
        priceEur: p.priceEur,
        free: !live,
      })),
    };
  })

  .post(
    "/billing/checkout",
    async ({ request, body }) => {
      const { tenant } = await requireTenantOrDevice(request.headers);
      if (!billingConfigured()) throw notFound("Payments are not configured on this host");

      const pack = pickTokenPackage(body?.requests);
      if (!pack) throw badRequest("Unknown request pack");
      const productId = productFor(pack.requests);
      // A pack with no product id exists in code but is not on sale: that is how a
      // test deployment offers one tier without deleting the others.
      if (!productId) throw notFound("That pack is not on sale");

      let session;
      try {
        session = await createCheckout({
          tenantId: tenant.id,
          requests: pack.requests,
          productId,
          email: body?.email ?? tenant.email ?? null,
          returnUrl: `${new URL(request.url).origin}/app?paid=1`,
        });
      } catch (err) {
        // The provider's own words, not a generic 500: a wrong product id and a
        // wrong API key must not look the same to whoever is wiring this up.
        const message = err instanceof Error ? err.message : "Checkout failed";
        console.error("[billing] checkout failed:", message);
        throw new HttpError(502, message, "upstream");
      }

      // Recorded before the money moves: if the webhook never arrives, this is the
      // row that says a checkout was started and nothing came back.
      await db.insert(auditLog).values({
        tenantId: tenant.id,
        action: "tokens.checkout",
        detail: {
          requests: pack.requests,
          priceEur: pack.priceEur,
          sessionId: session.sessionId,
          mode: billingMode(),
        },
      });

      return { url: session.url, sessionId: session.sessionId, mode: billingMode() };
    },
    {
      body: t.Optional(
        t.Object({
          requests: t.Optional(t.Number()),
          email: t.Optional(t.String()),
        }),
      ),
    },
  )

  /**
   * Dodo's webhook. Deliberately unauthenticated in the cookie sense: the signature
   * over the raw body is the authentication, and it is checked before the JSON is
   * even parsed, because parsing first and verifying after is how forged bodies get
   * through.
   */
  .post("/billing/webhook", async ({ request, set }) => {
    const raw = await request.text();
    const ok = verifyWebhook(raw, {
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    });
    if (!ok) throw forbidden("Bad webhook signature");

    const event = parsePaidEvent(JSON.parse(raw));
    // Every other event type is acknowledged and ignored: a 500 here makes the
    // provider retry an event we are never going to act on.
    if (!event) return { ok: true, ignored: true };

    const [owner] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, event.tenantId))
      .limit(1);
    if (!owner) {
      console.error(`[billing] paid for a workspace that does not exist: ${event.tenantId}`);
      return { ok: true, unknownTenant: true };
    }

    // Idempotent on the payment id: providers retry, and a double grant is money we
    // invented.
    const [seen] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "tokens.purchased"),
          sql`${auditLog.detail}->>'paymentId' = ${event.paymentId}`,
        ),
      )
      .limit(1);
    if (seen) return { ok: true, duplicate: true };

    const balance = await addTokens(event.tenantId, event.requests);
    await db.insert(auditLog).values({
      tenantId: event.tenantId,
      action: "tokens.purchased",
      detail: {
        paymentId: event.paymentId,
        requests: event.requests,
        amount: event.amount,
        currency: event.currency,
        email: event.email,
        mode: billingMode(),
      },
    });

    console.log(
      `[billing] ${event.requests} requests to ${event.tenantId} for payment ${event.paymentId} (${billingMode()})`,
    );
    set.status = 200;
    return { ok: true, granted: event.requests, balance };
  });
