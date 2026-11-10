/**
 * Dodo Payments, as a merchant of record.
 *
 * Two halves that must not be confused with each other:
 *
 *   checkout   our server asks Dodo for a hosted session and hands the browser a
 *              URL. No card data, no card form, nothing PCI-shaped on our side.
 *   webhook    Dodo tells us a payment happened. This is the only thing that may
 *              grant tokens: the redirect back from checkout is a user-controlled
 *              URL, so trusting it would let anyone mint packs for free.
 *
 * Test mode is the default, and the API key decides nothing about which host is
 * called: `PSH_DODO_MODE=live` does. A test key against the live host fails loudly
 * instead of charging a real card.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";

const HOSTS = {
  test: "https://test.dodopayments.com",
  live: "https://live.dodopayments.com",
} as const;

export function billingConfigured(): boolean {
  return Boolean(env.dodoApiKey && Object.keys(productMap()).length);
}

/**
 * `DODO_PRODUCTS` maps a pack's request count to the product id created in the
 * Dodo dashboard: `{"1000":"pdt_abc","10000":"pdt_def"}`. A pack with no product
 * is simply not purchasable, which is how a test deployment offers one tier.
 */
export function productMap(): Record<string, string> {
  const raw = process.env.DODO_PRODUCTS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [requests, id] of Object.entries(parsed)) {
      if (typeof id === "string" && id) out[requests] = id;
    }
    return out;
  } catch {
    console.error("[billing] DODO_PRODUCTS is not valid JSON");
    return {};
  }
}

export function productFor(requests: number): string | null {
  return productMap()[String(requests)] ?? null;
}

/** The test-mode indicator the dashboard shows, so a fake payment looks fake. */
export function billingMode(): "test" | "live" | "off" {
  if (!billingConfigured()) return "off";
  return env.dodoMode;
}

export interface CheckoutInput {
  tenantId: string;
  requests: number;
  productId: string;
  email?: string | null;
  name?: string | null;
  returnUrl: string;
}

export interface CheckoutSession {
  url: string;
  sessionId: string | null;
}

export async function createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
  const body = {
    // One product, one unit: quantity is the pack, not a count of packs. Buying
    // two packs is two sessions, which keeps the webhook's arithmetic trivial.
    product_cart: [{ product_id: input.productId, quantity: 1 }],
    customer: {
      ...(input.email ? { email: input.email } : {}),
      ...(input.name ? { name: input.name } : {}),
    },
    return_url: input.returnUrl,
    // The webhook is the authority on what was bought; this is what it reads back.
    metadata: {
      tenant_id: input.tenantId,
      requests: String(input.requests),
    },
  };

  const res = await fetch(`${HOSTS[env.dodoMode]}/checkouts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.dodoApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // The provider's message is more useful than a status code: it names the
    // missing product or the malformed field.
    throw new Error(`Dodo checkout failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as {
    checkout_url?: string;
    payment_link?: string;
    session_id?: string;
    id?: string;
  };
  const url = json.checkout_url ?? json.payment_link;
  if (!url) throw new Error(`Dodo checkout returned no URL: ${text.slice(0, 300)}`);
  return { url, sessionId: json.session_id ?? json.id ?? null };
}

/**
 * Standard Webhooks, which is what Dodo signs with: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}`, base64, sent as `webhook-signature: v1,<sig>`
 * (several signatures may be present when a secret is rotating).
 *
 * The raw body is required, re-serialising the JSON changes the bytes and the
 * signature with it, which is why the route reads text, not JSON.
 */
export function verifyWebhook(
  rawBody: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  now: number = Date.now(),
): boolean {
  const secret = env.dodoWebhookSecret;
  if (!secret) return false;
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const seconds = Number(timestamp);
  // Five minutes either way: a replayed body is worthless once it is stale, and
  // clock skew is real but not unbounded.
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;

  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const expected = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  const candidates = signature
    .split(" ")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part && part !== "v1");

  for (const candidate of candidates) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export interface PaidEvent {
  paymentId: string;
  tenantId: string;
  requests: number;
  amount: number | null;
  currency: string | null;
  email: string | null;
}

/**
 * Pull the parts we act on out of Dodo's payload. `payment.succeeded` is the only
 * event that grants tokens: `payment.processing` arrives first and can still fail,
 * and granting on it would mean paying for failures out of our own pocket.
 */
export function parsePaidEvent(payload: unknown): PaidEvent | null {
  const event = payload as {
    type?: string;
    data?: {
      payment_id?: string;
      id?: string;
      status?: string;
      total_amount?: number;
      currency?: string;
      customer?: { email?: string };
      metadata?: Record<string, string>;
    };
  };
  if (!event?.data) return null;
  const isPaid =
    event.type === "payment.succeeded" ||
    (event.type === "payment.updated" && event.data.status === "succeeded");
  if (!isPaid) return null;

  const meta = event.data.metadata ?? {};
  const tenantId = meta.tenant_id;
  const requests = Number(meta.requests);
  if (!tenantId || !Number.isFinite(requests) || requests <= 0) return null;

  const paymentId = event.data.payment_id ?? event.data.id;
  if (!paymentId) return null;

  return {
    paymentId,
    tenantId,
    requests: Math.trunc(requests),
    amount: typeof event.data.total_amount === "number" ? event.data.total_amount : null,
    currency: event.data.currency ?? null,
    email: event.data.customer?.email ?? null,
  };
}
