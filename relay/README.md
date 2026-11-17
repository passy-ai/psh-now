# psh-now-relay

Minimal, self-hostable push relay. Own your DB, your VAPID keys, your data.
Speaks the exact `/api/v1` contract the [`psh-now-sdk`](../sdk/) and all psh apps
expect, so connecting is one URL.

## Run

```bash
bun install
PSH_ADMIN_KEY=my-secret bun run server.ts
# → [relay] listening on http://localhost:8080
```

Config (env): `PSH_PORT` (8080), `PSH_DB` (`./psh.db`, SQLite via `bun:sqlite`),
`PSH_ADMIN_KEY` (bearer key for sends; generated + persisted if unset),
`PSH_ORIGIN` (public origin baked into push payloads), `PSH_SDK_DIST`
(optional: serve the SDK browser bundle + service worker yourself).

## Connect a site

```ts
import { createPsh } from "psh-now-sdk"

const psh = createPsh({ siteKey: "pk_local", apiUrl: "http://localhost:8080" })
await psh.promptForPermission()
```

Send (from your backend, with your admin key):

```bash
curl -X POST http://localhost:8080/api/v1/send \
  -H "authorization: Bearer $PSH_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"siteKey":"pk_local","title":"psh","body":"hello from my own relay"}'
```

## What it stores (your DB, SQLite file)

- `subscriptions`, endpoint, keys, tags, external id, UA
- `events`, impression / click / action_click / dismiss
- `settings`, generated VAPID keys + admin key
- `sites`, site keys seen

Single-tenant by design (you are the operator). Multi-tenant site management,
tracking dashboards and SLAs are the hosted/enterprise layer, not this package.
