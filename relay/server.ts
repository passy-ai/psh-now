// relay/server.ts — @psh/relay: minimal self-hostable push relay.
//
// Own your DB, own your VAPID keys, own your data. Speaks the exact /api/v1
// contract the @psh/sdk service worker and clients expect, so the SDK and all
// psh apps can point at it with one URL.
//
//   bun install && PSH_ADMIN_KEY=secret bun run server.ts
//
// Config (env):
//   PSH_PORT        default 8080
//   PSH_DB          SQLite file, default ./psh.db
//   PSH_ADMIN_KEY   bearer key for POST /api/v1/send (required for sends;
//                   generated once and persisted if not set)
//   PSH_ORIGIN      public origin used in push payloads, default http://localhost:PSH_PORT
//   PSH_SDK_DIST    optional path to the @psh/sdk dist dir; serves the browser
//                   bundle at /sdk/psh.global.js and the SW at /psh-sw.js
//
// Contract (same as psh.now/api/v1):
//   GET  /api/v1/vapid-key?siteKey=pk_…   → { vapidPublicKey }
//   POST /api/v1/subscribe                → { siteKey, endpoint, p256dhKey, authKey, …device }
//   POST /api/v1/unsubscribe              → { endpoint }
//   POST /api/v1/subscription-change      → re-subscribe payload
//   POST /api/v1/tags                     → { siteKey, endpoint, tags }
//   POST /api/v1/identify                 → { siteKey, endpoint, externalId }
//   POST /api/v1/track                    → { event, …ids }  (returns 200, stored)
//   GET  /api/v1/redirect?url=…&event=click&…  → 302 to url (logs the click)
//   POST /api/v1/send  (Bearer PSH_ADMIN_KEY) → { siteKey, title, body?, url?, icon?, badge? }
//   GET  /              → test page (if sdk dist available)
//   GET  /api/v1/health → { ok: true }
//
// Single-tenant by design: any siteKey is accepted and auto-registered —
// you are the operator of this relay. Multi-tenant/key management is the
// hosted/enterprise layer, not this package.

import { Database } from "bun:sqlite";

const PORT = Number(process.env.PSH_PORT ?? 8080);
const DB_PATH = process.env.PSH_DB ?? "./psh.db";
const SDK_DIST = process.env.PSH_SDK_DIST ?? "";
const ORIGIN = (process.env.PSH_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, "");

const db = new Database(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS sites (site_key TEXT PRIMARY KEY, name TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY, site_key TEXT NOT NULL,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    external_id TEXT, tags TEXT DEFAULT '{}',
    user_agent TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, site_key TEXT,
    endpoint TEXT, external_id TEXT, notification_id TEXT, campaign_id TEXT,
    url TEXT, at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_site ON events(site_key, event);
`);

// ---- VAPID keys: generate once, persist in the DB -----------------------
const { default: webpush } = await import("web-push");

let { publicKey: VAPID_PUB, privateKey: VAPID_PRIV } = (() => {
  const row = db.query("SELECT v FROM settings WHERE k='vapid'").get() as { v: string } | undefined;
  if (row) return JSON.parse(row.v);
  const keys = webpush.generateVAPIDKeys();
  db.query("INSERT INTO settings (k, v) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  console.log(`[relay] generated VAPID keys (stored in ${DB_PATH}); public key:\n  ${keys.publicKey}`);
  return keys;
})();

const getSetting = (k: string): string | null =>
  ((db.query("SELECT v FROM settings WHERE k=?").get(k) as { v?: string } | undefined)?.v ?? null);
const setSetting = (k: string, v: string) =>
  db.query("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

let ADMIN_KEY = process.env.PSH_ADMIN_KEY ?? getSetting("admin_key");
if (!ADMIN_KEY) {
  ADMIN_KEY = crypto.randomUUID().replace(/-/g, "");
  setSetting("admin_key", ADMIN_KEY);
  console.log(`[relay] generated admin key (stored in DB): ${ADMIN_KEY}`);
}

webpush.setVapidDetails(`mailto:admin@${new URL(ORIGIN).host ?? "relay.local"}`, VAPID_PUB, VAPID_PRIV);

// ---- helpers -------------------------------------------------------------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
const siteOf = (siteKey: string) => {
  db.query("INSERT INTO sites (site_key, name) VALUES (?, ?) ON CONFLICT(site_key) DO NOTHING").run(siteKey, siteKey);
  return siteKey;
};
const logEvent = (e: Record<string, any>) =>
  db.query(`INSERT INTO events (event, site_key, endpoint, external_id, notification_id, campaign_id, url)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    e.event ?? "unknown", e.siteKey ?? "", e.endpoint ?? "",
    e.externalId ?? null, e.notificationId ?? null,
    e.campaignId ?? null, e.url ?? null);

const sendPush = async (body: { siteKey?: string; title?: string; body?: string; url?: string; icon?: string; badge?: string }) => {
  const siteKey = body.siteKey ?? "pk_default";
  siteOf(siteKey);
  const subs = db.query("SELECT endpoint, p256dh, auth FROM subscriptions WHERE site_key=?").all(siteKey) as any[];
  const payload = JSON.stringify({
    title: body.title ?? "psh", body: body.body ?? "",
    icon: body.icon, badge: body.badge,
    data: { url: body.url ?? "/", apiUrl: ORIGIN, siteKey },
  });
  const results: any[] = [];
  for (const s of subs) {
    try {
      const r = await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload, { TTL: 3600 });
      results.push({ status: r.statusCode, endpoint: s.endpoint.slice(0, 60) });
    } catch (e: any) {
      const code = e?.statusCode ?? 0;
      if (code === 404 || code === 410) {
        db.query("DELETE FROM subscriptions WHERE endpoint=?").run(s.endpoint);
        results.push({ status: code, removed: true, endpoint: s.endpoint.slice(0, 60) });
      } else results.push({ status: code, error: String(e?.message ?? e).slice(0, 90), endpoint: s.endpoint.slice(0, 60) });
    }
  }
  return { ok: true, sent: results.filter(r => r.status >= 200 && r.status < 300).length, results };
};

// ---- server --------------------------------------------------------------
const serveSdkAsset = (path: string) => {
  if (!SDK_DIST) return null;
  const file = Bun.file(`${SDK_DIST}/${path}`);
  return file.size ? new Response(file, { headers: { "content-type": path.endsWith(".js") ? "text/javascript" : "application/octet-stream" } }) : null;
};

const TEST_PAGE = `<!doctype html><html><head><title>psh relay</title></head>
<body style="font-family:sans-serif">
<h3>psh relay — SDK test</h3>
<button id="sub">Subscribe</button> <button id="send">Send test push</button>
<pre id="log" style="white-space:pre-wrap"></pre>
<script src="/sdk/psh.global.js"></script>
<script>
const L = (m) => { document.getElementById("log").textContent += m + "\\n"; };
window.psh = Psh.createPsh({ siteKey: "pk_local", apiUrl: location.origin, autoPrompt: false, banner: false, debug: true,
  onSubscribe: (s) => L("SUBSCRIBED: " + s.endpoint) });
document.getElementById("sub").onclick = () => window.psh.promptForPermission().then(s => L(s ? "subscribed" : "permission denied"));
document.getElementById("send").onclick = async () => {
  const r = await fetch("/api/v1/send", { method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + (localStorage.pshAdminKey || prompt("admin key")) },
    body: JSON.stringify({ siteKey: "pk_local", title: "psh relay", body: "self-hosted push works" }) });
  const j = await r.json(); if (j.results && j.results[0]) localStorage.pshAdminKey = localStorage.pshAdminKey || prompt("admin key") || "";
  L("send: " + JSON.stringify(j).slice(0, 200));
};
</script></body></html>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    console.log(`[req] ${req.method} ${path}`);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const body = async () => await req.json().catch(() => ({}));

    if (path === "/api/v1/health") return json({ ok: true, origin: ORIGIN });
    if (path === "/api/v1/vapid-key")
      return json({ vapidPublicKey: VAPID_PUB });

    if (path === "/api/v1/subscribe" && req.method === "POST") {
      const b = await body();
      if (!b.endpoint || !b.p256dhKey || !b.authKey) return json({ error: "endpoint, p256dhKey, authKey required" }, 400);
      siteOf(b.siteKey ?? "pk_default");
      db.query(`INSERT INTO subscriptions (endpoint, site_key, p256dh, auth, user_agent)
                VALUES (?,?,?,?,?)
                ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, site_key=excluded.site_key`)
        .run(b.endpoint, b.siteKey ?? "pk_default", b.p256dhKey, b.authKey, req.headers.get("user-agent") ?? "");
      return json({ ok: true });
    }
    if (path === "/api/v1/unsubscribe" && req.method === "POST") {
      const b = await body();
      db.query("DELETE FROM subscriptions WHERE endpoint=?").run(b.endpoint ?? "");
      return json({ ok: true });
    }
    if (path === "/api/v1/subscription-change" && req.method === "POST") {
      const b = await body();
      if (b.endpoint && b.p256dhKey && b.authKey) {
        db.query(`INSERT INTO subscriptions (endpoint, site_key, p256dh, auth) VALUES (?,?,?,?)
                  ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`)
          .run(b.endpoint, b.siteKey ?? "pk_default", b.p256dhKey, b.authKey);
      }
      return json({ ok: true });
    }
    if (path === "/api/v1/tags" && req.method === "POST") {
      const b = await body();
      db.query("UPDATE subscriptions SET tags=? WHERE endpoint=?").run(JSON.stringify(b.tags ?? {}), b.endpoint ?? "");
      return json({ ok: true });
    }
    if (path === "/api/v1/identify" && req.method === "POST") {
      const b = await body();
      db.query("UPDATE subscriptions SET external_id=? WHERE endpoint=?").run(b.externalId ?? null, b.endpoint ?? "");
      return json({ ok: true });
    }
    if (path === "/api/v1/track" && req.method === "POST") {
      const raw = await req.text();
      let b: any = {}; try { b = JSON.parse(raw); } catch { b = { __raw: raw.slice(0, 120) }; }
      // SDK field names: eventType, subscriberId (no endpoint), …
      logEvent({ event: b.eventType ?? b.event, siteKey: b.siteKey, endpoint: b.endpoint ?? b.subscriberId,
                 externalId: b.externalId ?? b.subscriberId,
                 notificationId: b.notificationId, campaignId: b.campaignId, url: b.url });
      if (b.__raw !== undefined) console.log("[track] unparseable body:", b.__raw);
      return json({ ok: true });
    }
    if (path === "/api/v1/redirect") {
      logEvent({ event: url.searchParams.get("event") ?? url.searchParams.get("eventType") ?? "click",
                 siteKey: url.searchParams.get("siteKey") ?? url.searchParams.get("sk"),
                 endpoint: url.searchParams.get("endpoint") ?? url.searchParams.get("sid"),
                 url: url.searchParams.get("url") });
      const to = url.searchParams.get("url");
      return to ? Response.redirect(to, 302) : json({ ok: true });
    }

    if (path === "/api/v1/send" && req.method === "POST") {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${ADMIN_KEY}`) return json({ error: "unauthorized" }, 401);
      return json(await sendPush(await body()));
    }

    if (path === "/" && SDK_DIST) return new Response(TEST_PAGE, { headers: { "content-type": "text/html" } });
    if (path === "/sdk/psh.global.js") { const r = serveSdkAsset("browser/psh.global.js"); if (r) return r; }
    if (path === "/psh-sw.js") { const r = serveSdkAsset("browser/psh-sw.global.js"); if (r) return r; }

    return json({ error: "not found", path }, 404);
  },
});

console.log(`[relay] listening on ${ORIGIN}  (db: ${DB_PATH})`);
if (!SDK_DIST) console.log("[relay] tip: set PSH_SDK_DIST to the @psh/sdk dist dir to get the test page + SW hosting");
