# Webhooks: design (not implemented yet)

> Status: **not implemented.** The marketing site (`website/`) advertises "every
> decision fires a signed webhook", that is aspirational. This doc is the spec to
> build it later. Until then, the real mechanisms are the **WebSocket** (`/ws`)
> and **`wait:false` + `pollUrl`**.

## Why

Headless agents and external systems (CI, Slack, ticketing) can't hold a
WebSocket or poll forever. A webhook lets *anything* react to a decision without
being connected. It's also the honest way to deliver on the marketing claim.

## What it is

On every **decision** (and optionally on **creation** / **expiry**), POST a
signed JSON body to each of the account's registered endpoints.

## Data model

New table `webhook_endpoints`:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | short id |
| `tenant_id` | text → tenants | owner |
| `url` | text | https (allow http only in dev) |
| `secret` | text | HMAC key, shown once at creation |
| `events` | jsonb | `["decision"]` by default |
| `active` | boolean | pause without deleting |
| `description` | text | "CI", "Slack", … |
| `created_at` | timestamp | |

New table `webhook_deliveries` (for retries + a delivery log):

| Column | Notes |
|---|---|
| `id` | PK |
| `endpoint_id` | → webhook_endpoints |
| `prompt_id` | → prompts |
| `event` | decision/created/expired |
| `payload` | jsonb (what we sent) |
| `status` | `pending` / `ok` / `failed` |
| `attempts` | int |
| `response_status` | int nullable |
| `next_attempt_at` | timestamp nullable |
| `created_at` / `delivered_at` | timestamps |

## Events

| Event | Fires when | Default |
|---|---|---|
| `decision` | a human approves/denies (or it expires) | ✅ |
| `created` | a request is created | opt-in |
| `expired` | a request times out with no answer | opt-in |

## Payload

```json
{
  "event": "decision",
  "id": "evt_8f3c",
  "prompt": {
    "id": "apr_8f3c",
    "channelId": "KchCyq4gcKC",
    "title": "Deploy to production",
    "message": "Deploy build 4821?",
    "kind": "action"
  },
  "approved": true,
  "status": "approved",
  "by": { "type": "device", "id": "dev_…", "name": "iPhone" },
  "reason": null,
  "at": "2026-01-14T14:02:11Z"
}
```

`by.type` is `device` (a paired phone/tablet), `key` (the account key), or
`timeout`.

## Signing

Each endpoint has a secret. On delivery:

```
X-Psh-Event: decision
X-Psh-Delivery: dlv_…
X-Psh-Timestamp: 1768400000
X-Psh-Signature: sha256=<hex HMAC-SHA256(secret, "{timestamp}.{rawBody}")>
```

Receivers verify the HMAC over `timestamp + "." + body` and reject if the
timestamp is older than ~5 minutes (replay protection). Sign the **raw bytes**,
before any re-serialisation.

## Delivery

- `POST` the JSON, `Content-Type: application/json`, timeout **10s**.
- Treat **2xx** as success. Anything else (or timeout) is a failure.
- Retries: exponential backoff, ~10s, 1m, 5m, 30m, 2h (5 attempts), then give
  up and mark `failed`. A background sweeper (like `expireStalePrompts`) drives
  `next_attempt_at`.
- Idempotency: `X-Psh-Delivery` is stable per attempt-set, so receivers can
  dedupe.

## API

All `manage` scope (a webhook URL + secret is a credential):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/me/webhooks` | list endpoints (secret redacted) |
| `POST` | `/api/v1/me/webhooks` | create (returns the secret **once**) |
| `PATCH` | `/api/v1/me/webhooks/:id` | edit url / events / active / description |
| `DELETE` | `/api/v1/me/webhooks/:id` | remove |
| `POST` | `/api/v1/me/webhooks/:id/test` | send a sample `decision` payload |
| `GET` | `/api/v1/me/webhooks/:id/deliveries` | recent delivery log |

## UI

Account card → **Webhooks**: a list with a status dot, "Add endpoint", a "Send
test" button, and a delivery log. Mirrors the marketing mock.

## Security

1. **SSRF.** The server fetches a user-supplied URL. Block private ranges
   (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`) and
   non-http(s) schemes. Resolve DNS and re-check (or use an allowlist).
2. **Secret at rest.** Store encrypted (reuse `encryptSecret`/`decryptSecret`)
   so it can be shown again to the owner, or hash-only and shown once. Prefer
   **shown once + encrypted at rest** for retries.
3. **Payload leakage.** The payload contains request titles/messages, which may
   be sensitive. Say so at creation; let the user pick a minimal payload.
4. **Rate limits.** Cap endpoints per account (e.g. 10) and deliveries/minute.

## Open questions

- Do we sign with a per-endpoint secret, or one account-wide secret? (Per-endpoint
  is safer; account-wide is fewer things to manage.)
- Minimal payload vs full payload, default to full, offer minimal.
- Should `created` be on by default? (Probably not, noisy.)
- Deliver from the request path or a queue? (Queue/outbox, never block a decision
  on a third-party POST.)
