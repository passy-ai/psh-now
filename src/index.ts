import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { productVersion } from "./lib/version";
import { Elysia } from "elysia";
import { env } from "./env";
import { mailTransport, warnIfUnconfigured } from "./services/mail";
import { pageHtml, stampAssets } from "./lib/pages";
import { joinPrompt } from "./lib/prompt-templates";
import { canonicalPath, injectNoIndex, injectSeo, rewriteRelative } from "./lib/seo";
import { HttpError } from "./lib/http";
import { allow, clientId } from "./lib/ratelimit";
import { apiKeyFromHeaders } from "./lib/crypto";
import { findKeyAuth } from "./services/tenants";
import { findDeviceByToken } from "./services/devices";
import { startPubSub, stopPubSub } from "./lib/pubsub";
import { handleDecisionEvent } from "./services/decisions";
import { sweepExpiredTenants } from "./services/tenants";
import { expireStalePrompts } from "./services/prompts";
import { sql } from "./db";
import { authRoutes, agentAuthRoutes } from "./routes/auth";
import { identityRoutes } from "./routes/identity";
import { profileRoutes } from "./routes/profile";
import { discoveryRoutes, llmsTxt } from "./routes/discovery";
import { hookRoutes } from "./routes/hook";
import { promptRoutes } from "./routes/prompts";
import { peekInvite } from "./services/invites";
import { pushRoutes } from "./routes/push";
import { billingRoutes } from "./routes/billing";
import { wsRoutes } from "./routes/ws";
import { auth } from "./auth";

// Optional direct TLS: set TLS_CERT_FILE + TLS_KEY_FILE and Bun terminates
// HTTPS/WSS itself, so no reverse proxy (Caddy/nginx) is required.
async function loadTls() {
  if (!env.tlsCertFile || !env.tlsKeyFile) return undefined;
  try {
    return {
      cert: await Bun.file(env.tlsCertFile).text(),
      key: await Bun.file(env.tlsKeyFile).text(),
    };
  } catch (err) {
    console.error("[tls] failed to read cert/key:", err);
    process.exit(1);
  }
}
const tls = await loadTls();
const scheme = tls ? "https" : "http";

/**
 * Routes that only a management key (or a paired device) may call. An `ask`
 * key - what agents, channel keys and join links carry - can create and read
 * its own approvals but can never approve or administer the account.
 */
const SCOPE_RANK = { ask: 0, approve: 1, manage: 2 } as const;
type Scope = keyof typeof SCOPE_RANK;

/**
 * Minimum scope a route requires:
 *   ask      - create/read your own requests (channel keys)
 *   approve  - read the account + approve/deny (the browser account key)
 *   manage   - administer the account (the account SECRET key)
 */
function requiredScope(method: string, path: string): Scope {
  // Reads never need the secret. Only writes/administration do.
  if (path.startsWith("/api/v1/profile")) return method === "GET" ? "approve" : "manage";
  if (path.startsWith("/api/v1/devices")) {
    // Pairing a device is a normal owner action (it mints an approve-scoped
    // device token), so the account key may do it. Revoking/renaming needs
    // the secret.
    if (path.startsWith("/api/v1/devices/pairing")) return "approve";
    return method === "GET" ? "approve" : "manage";
  }
  if (
    path.startsWith("/api/v1/me/keys") ||
    path.startsWith("/api/v1/me/rotate")
  ) {
    return "manage";
  }
  // Buying a request package is the owner's own billing action, so the
  // account key may do it (the route itself refuses outside dev mode).
  if (path.startsWith("/api/v1/me/tokens")) return "approve";
  // Claiming an account with an emailed code is part of normal onboarding, so
  // the approving (account) key - the one in the claim link - may do it.
  if (path.startsWith("/api/v1/me/register")) return "approve";
  // Taking a fresh install's anonymous workspace into this account: the owner's
  // own action, from the dashboard, with the account key they are signed in as.
  if (path.startsWith("/api/v1/me/adopt")) return "approve";
  // Creating the admin secret is a one-time bootstrap from the dashboard.
  if (path.startsWith("/api/v1/me/secret")) return "approve";
  if (path.startsWith("/api/v1/channels")) {
    // Inviting another registered account is a normal owner action (the route
    // itself refuses unregistered inviters).
    if (path.includes("/invites")) return "approve";
    // Minting/revoking the channel's own invite link (share menu) is also the
    // owner's action - it is how they add an approver.
    if (path.includes("/invite-link")) return "approve";
    // Read-only: returns the channel's public URL (`/c/<channel>`).
    if (path.includes("/join-link")) return "ask";
    // The owner's account key may create a channel and mint agent keys for it,
    // and edit a channel (name, colour, URL). Deleting still needs the secret.
    if (method === "PATCH") return "approve";
    if (method === "POST" && (/^\/api\/v1\/channels\/?$/.test(path) || path.endsWith("/keys"))) {
      return "approve";
    }
    // Deleting a channel is the owner's own action, reachable from the card's
    // `…` menu with the account key.
    if (method === "DELETE") return "approve";
    return method === "POST" ? "manage" : "ask";
  }
  if (/^\/api\/v1\/approvals\/[^/]+\/decision$/.test(path)) return "approve";
  return "ask";
}

/** Rate limits for the endpoints an attacker would hammer (brute-force tokens/codes). */
function rateRule(
  method: string,
  path: string,
): { limit: number; windowMs: number } | null {
  if (method !== "POST") return null;
  if (path === "/api/v1/mint") return { limit: 10, windowMs: 60_000 };
  if (path === "/api/v1/auth/otp") return { limit: 5, windowMs: 60_000 };
  if (path.startsWith("/api/v1/join/")) return { limit: 30, windowMs: 60_000 };
  if (path.startsWith("/api/v1/pairing/")) return { limit: 30, windowMs: 60_000 };
  if (path.endsWith("/verify")) return { limit: 15, windowMs: 60_000 };
  if (path.endsWith("/verify-code")) return { limit: 15, windowMs: 60_000 };
  return null;
}

/**
 * Is this a person who *clicked* the link, or a program that merely said it accepts
 * HTML? `Accept` alone cannot tell them apart, and the difference is not cosmetic:
 * an agent fetch tool sends a browser-like Accept, and the browser page it would get
 * fills in the join command with client-side JS - so the agent receives something
 * that reads like instructions and contains none (`<p id="prompt"></p>`).
 *
 * Browsers advertise an actual navigation in `Sec-Fetch-*`; a fetcher does not, so
 * "no Sec-Fetch headers" means text. A browser too old to send Sec-Fetch gets the
 * plain-text instructions, which any browser still renders fine.
 */
function isBrowserNavigation(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/html")) return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return false;
}

/** The text form: markdown only if the caller asked for markdown, else plain text. */
function textResponse(request: Request, body: string): Response {
  const wantsMarkdown = (request.headers.get("accept") || "").includes("text/markdown");
  return new Response(body, {
    headers: {
      "content-type": wantsMarkdown ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    },
  });
}

/**
 * The confirmation tail both instruction bodies share: say you are connected, then
 * route every question to psh.now instead of stalling in the terminal.
 */
function carryOn(base: string): string {
  return `## 2. Carry on

From now on, whenever you would ask the user a question, send it to psh.now as a
yes/no on your recommended route and wait for the answer.

\`\`\`bash
curl -s -X POST ${base} -H "x-psh-key: <channelKey>" -H "content-type: application/json" \\
  -d '{"title":"<short title>","message":"<what you are about to do>","wait":false}'
\`\`\`
`;
}

/**
 * Instructions an agent receives when it fetches a channel link (/c/<id-or-slug>).
 *
 * Join only. The combined install-and-join prompt lives in the docs: a machine that
 * already has the skill must never be told to install again, because that is how a
 * second account gets minted (observed 2026-10-17).
 */
function channelInstructions(idOrSlug: string): string {
  const b = env.publicBaseUrl;
  const url = `${b}/c/${idOrSlug}`;
  return `# Connect to a psh.now channel

You were asked to use **psh.now** for one channel. Connecting gives you a channel
key bound to that channel: **ask-only**, so you can create approval requests there,
but never approve, and never read another channel.

## 1. Install and join

Join this channel with:

\`\`\`text
${joinPrompt(url)}
\`\`\`

Nothing installed yet? The combined install-and-join prompt is in the docs:
${b}/docs

Do **not** run a plain install first: it would mint a brand-new anonymous account
instead of attaching to this channel. If the machine-wide writes are refused (a
sandbox), the run falls back to this folder and is **not** finished: say so in one
line, route ONE ask - \`psh ask "Install psh.now globally?"…\` - and re-run with the
permissions granted. The last line of the output says which happened:
\`psh_machine_wide=ok\` or \`psh_machine_wide=incomplete\`.

Already set up in this folder? Then just:

\`\`\`bash
./.psh/bin/psh setup --join ${url}
\`\`\`

It prints a **channel key bound to this channel**; requests you send land there.

${carryOn(b)}`;
}

/**
 * The same for an invite link (/invite/<token>), which points at a channel the
 * agent has not been told about yet. Join only, for the same reason as above.
 */
function inviteInstructions(token: string): string {
  const b = env.publicBaseUrl;
  const url = `${b}/invite/${token}`;
  return `# Join a psh.now channel as a requester

This invite link points at a channel on **psh.now**: the approval layer that lets
you ask the user a question instead of stalling in the terminal.

Joining makes you a **requester**: you get a channel key that is **ask-only**. You
can create approval requests on that channel, but you can never approve, and you
can never read another channel.

## 1. Install and join

Join this channel with:

\`\`\`text
${joinPrompt(url)}
\`\`\`

Nothing installed yet? The combined install-and-join prompt is in the docs:
${b}/docs

Do **not** run the install steps from \`/setup.md\` first: a plain install mints a
brand-new anonymous account instead of attaching to this channel. If the machine-wide
writes are refused (a sandbox), the run falls back to this folder and is **not**
finished: say so in one line, route ONE ask - \`psh ask "Install psh.now globally?"…\` -
and re-run with the permissions granted. The last line of the output says which
happened: \`psh_machine_wide=ok\` or \`psh_machine_wide=incomplete\`.

Already set up in this folder? Then just:

\`\`\`bash
./.psh/bin/psh setup --join ${url}
\`\`\`

It prints a **channel key bound to this channel**. The link may have expired:
if it has, ask the person who shared it for a fresh one.

**No test request is needed.** Do not run the install steps from \`/setup.md\`. Just
carry on.

${carryOn(b)}`;
}

/**
 * A marketing page, served from `website/`.
 *
 * Not `pageHtml()`: this site carries its own copies of the assets and its own
 * relative links, so it goes through `rewriteRelative()` (assets move under
 * `/website/`, links between pages point at their canonical address) and then the
 * same stamp, or Cloudflare's 4-day `.js` cache serves yesterday's install prompt.
 */
async function websiteResponse(
  rel: string,
  transform?: (html: string) => string,
): Promise<Response> {
  const file = Bun.file(`website/${rel}`);
  if (!(await file.exists())) return notFound();
  let html = await stampAssets(await file.text());
  html = rewriteRelative(html);
  html = injectSeo(html, canonicalPath(rel) ?? `/${rel.replace(/\.html$/, "")}`);
  if (transform) html = transform(html);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** `/` - the marketing home, whose own app.js hands out the install prompt. */
function websiteHome(): Promise<Response> {
  return websiteResponse("index.html");
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const ASSET_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css;charset=utf-8",
  js: "text/javascript;charset=utf-8",
  mjs: "text/javascript;charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  json: "application/json;charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  webmanifest: "application/manifest+json",
  map: "application/json;charset=utf-8",
};

/**
 * A file from disk, with the extension's type.
 *
 * Cloudflare caches `.css`/`.js` for days whatever we say, which is why the pages
 * stamp their asset URLs; the long `max-age` here matches what the edge does anyway.
 * `pageHtml()` serves the HTML pages and stays uncached.
 */
async function serveAsset(path: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return notFound();
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return new Response(file, {
    headers: {
      "content-type": ASSET_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "max-age=345600",
    },
  });
}

const BIND_ATTEMPTS = 20;
const BIND_RETRY_MS = 500;

/**
 * Refuse to start when a real psh.now already answers on this port.
 *
 * Not a bare TCP connect: a listener that was just killed can keep accepting
 * connections for tens of seconds, so a TCP check refuses on a ghost and leaves the
 * app down. Elysia turns SO_REUSEPORT on by default, which let a duplicate bind
 * happily and split connections between two instances ("random reloading") - so the
 * server is created with `reusePort: false` and this asks the health endpoint.
 */
async function assertPortFree(): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${env.port}/api/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { ok?: boolean };
    if (body?.ok) {
      console.error(
        `[start] psh.now is already listening on ${env.host}:${env.port}. Stop it first:`,
      );
      console.error("        check the tunnel or proxy in front of this server");
      process.exit(1);
    }
  } catch {
    // Nothing answers: the port is ours.
  }
}

/** Endpoints that must work with no key at all. Everything else is checked below. */
function isPublicPath(path: string): boolean {
  return (
    path === "/api/v1/health" ||
    path.startsWith("/api/v1/mint") ||
    path.startsWith("/api/v1/auth/") ||
    path.startsWith("/api/v1/join/") ||
    path.startsWith("/api/v1/pairing/") ||
    path.startsWith("/api/v1/invites/")
  );
}

/**
 * Dev work is meant to happen through the public tunnel, so that cookies, the checkout
 * return URL and every link the server prints agree on one origin with the phone and the
 * webhook. Opening the loopback address directly would quietly create a second origin and
 * a second session, which is exactly the confusion this removes: anything on localhost or
 * 127.0.0.1 is sent to the canonical host. `PSH_ALLOW_LOCAL_ORIGIN=1` opts out for scripted
 * checks, and it is inert in production and whenever the base URL is still plain http.
 */
const canonicalHost = env.publicBaseUrl.startsWith("https://") ? env.publicBaseUrl : null;
const redirectLoopback =
  canonicalHost !== null && !env.isProduction && process.env.PSH_ALLOW_LOCAL_ORIGIN !== "1";

function loopbackRedirect(request: Request): Response | null {
  if (!redirectLoopback) return null;
  const url = new URL(request.url);
  const host = url.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return null;
  // The healthcheck is not a browser session, so there is no origin to unify: it
  // asks this very process whether it is serving yet. Redirecting it sends the
  // probe out to the public hostname and back through the tunnel, which answers
  // 502 exactly when the service has no healthy task — the state the probe is
  // meant to detect. Loop it back and the probe can only ever report "down".
  if (url.pathname === "/api/v1/health") return null;
  return Response.redirect(`${canonicalHost}${url.pathname}${url.search}`, 302);
}

/**
 * One canonical host, always.
 *
 * Every page is reachable on whatever hostname the client typed, which means the same bytes are
 * served under two names and a crawler has to pick one. Rather than trust a canonical tag to
 * settle that, a request for HTML on a host that is not `PUBLIC_BASE_URL` is answered with a
 * permanent redirect. API paths are exempt: an agent must be able to reach the API on the host
 * it was configured with, and a redirect there would be a silent latency tax on every call.
 */
function canonicalRedirect(request: Request): Response | null {
  if (canonicalHost === null) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/html")) return null;
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/health" || url.pathname.startsWith("/api/")) return null;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (loopback && process.env.PSH_ALLOW_LOCAL_ORIGIN === "1") return null;
  if (url.host === new URL(canonicalHost).host) return null;
  return Response.redirect(`${canonicalHost}${url.pathname}${url.search}`, 301);
}

const app = new Elysia({ serve: { reusePort: false } })
  .onRequest(({ request }) => {
    if (process.env.PSH_TIMING === "1") {
      (request as Request & { _t0?: number })._t0 = performance.now();
    }
    return loopbackRedirect(request) ?? canonicalRedirect(request) ?? undefined;
  })
  .onAfterHandle(({ request }) => {
    if (process.env.PSH_TIMING !== "1") return;
    const t0 = (request as Request & { _t0?: number })._t0;
    if (t0 === undefined) return;
    const url = new URL(request.url);
    console.log(`[timing] ${(performance.now() - t0).toFixed(0)}ms ${url.pathname}${url.search}`);
  })
  .use(cors())
  .use(
    swagger({
      path: "/openapi",
      provider: "scalar",
      documentation: {
        info: {
          title: "psh.now",
          version: productVersion(),
          description:
            "Secure transaction broker between local AI agents and a developer's phone.",
        },
        tags: [{ name: "approvals", description: "Ask the human a question" }],
      },
    }),
  )
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.code, message: error.message, details: error.details };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: "validation", message: error.message };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "NOT_FOUND", message: "NOT_FOUND" };
    }
    set.status = 500;
    return { error: "internal", message: "Something went wrong" };
  })
  /**
   * One guard for every API call: the rate limit first (the endpoints an attacker
   * hammers), then the scope. A route that needs more than `ask` refuses a missing or
   * too-small key here, so an agent's channel key can never approve or administer.
   */
  .onBeforeHandle(async ({ request }) => {
    const { pathname } = new URL(request.url);
    const rule = rateRule(request.method, pathname);
    if (rule && !allow(`${clientId(request.headers)}:${pathname}`, rule.limit, rule.windowMs)) {
      throw new HttpError(429, "Too many requests. Try again in a minute.", "rate_limited");
    }
    if (!pathname.startsWith("/api/")) return;
    const needed = requiredScope(request.method, pathname);
    if (needed === "ask" || isPublicPath(pathname)) return;

    // A paired device carries its token in its own header, not x-psh-key. Pairing
    // is exactly how a phone earns the right to approve, so the token is approving
    // by construction, and it stops there: a device can never administer the
    // account, whatever the route asks for.
    const deviceToken = request.headers.get("x-psh-device")?.trim();
    if (deviceToken) {
      const device = await findDeviceByToken(deviceToken);
      if (!device) throw new HttpError(401, "Invalid or revoked device token", "unauthorized");
      if (SCOPE_RANK.approve < SCOPE_RANK[needed]) {
        throw new HttpError(
          403,
          "A paired device cannot administer this route.",
          "insufficient_scope",
        );
      }
      return;
    }

    const raw = apiKeyFromHeaders(request.headers);
    if (!raw) throw new HttpError(401, "Provide an API key via x-psh-key", "unauthorized");
    const found = await findKeyAuth(raw);
    if (!found) throw new HttpError(401, "That API key is not valid", "unauthorized");
    if (SCOPE_RANK[found.scope] < SCOPE_RANK[needed]) {
      throw new HttpError(
        403,
        `This key is ${found.scope}-scoped and cannot ${needed} this route.`,
        "insufficient_scope",
      );
    }
  })
  // ── API
  .use(authRoutes)
  .use(agentAuthRoutes)
  .use(identityRoutes)
  .use(profileRoutes)
  .use(discoveryRoutes)
  .use(hookRoutes)
  .use(promptRoutes)
  .use(pushRoutes)
  .use(billingRoutes)
  .use(wsRoutes)
  .mount(auth.handler)
  // ── pages
  .get("/", () => websiteHome())
  .get("/website", () => Response.redirect("/", 301))
  .get("/website/", () => Response.redirect("/", 301))
  .get("/app", () => pageHtml("public/channels.html", injectNoIndex))
  .get("/login", () => pageHtml("public/channels.html", injectNoIndex))
  .get("/channels", () => Response.redirect("/app", 302))
  .get("/devices", () => pageHtml("public/devices.html", injectNoIndex))
  .get("/connect", () => pageHtml("public/connect.html", injectNoIndex))
  .get("/teams", () => websiteResponse("teams.html"))
  .get("/alternatives", () => websiteResponse("alternatives.html"))
  .get("/privacy", () => websiteResponse("privacy.html"))
  .get("/terms", () => websiteResponse("terms.html"))
  .get("/claim", () => pageHtml("public/claim.html", injectNoIndex))
  .get("/pair/:token", () => pageHtml("public/pair.html", injectNoIndex))
  .get("/c/:idOrSlug", ({ request, params }) => {
    if (isBrowserNavigation(request)) return pageHtml("public/join.html", injectNoIndex);
    return textResponse(request, channelInstructions(params.idOrSlug));
  })
  .get("/invite/:token", async ({ request, params }) => {
    if (isBrowserNavigation(request)) return pageHtml("public/invite.html", injectNoIndex);
    return textResponse(request, inviteInstructions(params.token));
  })
  .get("/j/:token", async ({ request, params }) => {
    const invite = await peekInvite(params.token);
    if (invite && isBrowserNavigation(request)) return pageHtml("public/invite.html", injectNoIndex);
    if (invite) return Response.redirect(`${env.publicBaseUrl}/invite/${params.token}`, 302);
    return new Response(
      'This one-time join link is no longer used. To connect an agent, use a channel link instead - on the dashboard, the channel card\'s "Copy prompt for agent" button.\n',
      { status: 410, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  })
  ;

/**
 * Static files, one explicit route each.
 *
 * Deliberately not a `/:file` catch-all: with one in place Elysia let it match
 * `/openapi` ahead of the Swagger UI route the plugin had registered, so the API
 * reference answered 404. Explicit routes cannot shadow anything, and the list is
 * read from disk at startup. Already-claimed paths (`/pricing.md`,
 * `/psh-now.tar.gz`, the page routes) are skipped.
 */
const claimedRoutes = new Set(app.routes.filter((r) => r.method === "GET").map((r) => r.path));
for (const rel of [...new Bun.Glob("**/*").scanSync({ cwd: "website" })].sort()) {
  const path = `/website/${rel}`;
  if (claimedRoutes.has(path)) continue;
  app.get(path, () => serveAsset(`website/${rel}`));
  claimedRoutes.add(path);
}
for (const rel of [...new Bun.Glob("**/*").scanSync({ cwd: "public" })].sort()) {
  const path = `/${rel}`;
  if (claimedRoutes.has(path)) continue;
  app.get(path, () => serveAsset(`public/${rel}`));
  claimedRoutes.add(path);
}

const DECISION_SWEEP_MS = 60_000;

await assertPortFree();

// The Postgres LISTEN connection behind live decisions. `stopPubSub` on the way out
// so a graceful restart does not leave a listener that duplicates every frame.
void startPubSub(handleDecisionEvent).catch((err) => console.error("[pubsub] failed:", err));

const sweeper = setInterval(() => {
  void sweepExpiredTenants().catch((err) => console.error("[sweep] tenants:", err));
  void expireStalePrompts().catch((err) => console.error("[sweep] prompts:", err));
}, DECISION_SWEEP_MS);
sweeper.unref();

async function shutdown(signal: string) {
  console.log(`[stop] ${signal}`);
  clearInterval(sweeper);
  await stopPubSub().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// The bind retries briefly: a predecessor's socket is not always released the moment
// its process disappears, and that read as an outage on 2026-10-15.
for (let attempt = 1; ; attempt++) {
  try {
    app.listen({
      port: env.port,
      hostname: env.host,
      ...(tls ? { tls } : {}),
    });
    break;
  } catch (err) {
    if (attempt >= BIND_ATTEMPTS) {
      console.error(`[bind] could not listen on ${env.host}:${env.port} after ${attempt} attempts:`, err);
      process.exit(1);
    }
    await Bun.sleep(BIND_RETRY_MS);
  }
}

warnIfUnconfigured();
console.log(`psh.now listening on ${scheme}://${env.host}:${env.port} (public: ${env.publicBaseUrl})`);
if (!env.isProduction) {
  console.log(`mail: ${mailTransport() === "none" ? "not configured (codes print here)" : mailTransport()}`);
}
console.log(`llms.txt: ${llmsTxt().length} bytes`);
