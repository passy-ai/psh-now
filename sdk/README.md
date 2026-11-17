# psh-now-sdk

Web push SDK for psh. One client class, one service worker, five HTTP calls.
Works with [psh.now](https://psh.now) or your own relay ,
[`psh-now-relay`](../relay/) is the self-host option: own DB, own keys, own data.

## Install

```bash
npm install psh-now-sdk
```

Or without npm: the browser build ships as plain files you can host yourself:

- `dist/browser/psh.global.js`, the client as `<script>` (global `Psh`)
- `dist/browser/psh-sw.global.js`, the service worker (serve it at `/psh-sw.js`)

## Use

```ts
import { createPsh } from "psh-now-sdk"

const psh = createPsh({
  siteKey: "pk_your-site",           // from your relay
  apiUrl: "https://psh.now",         // or your own psh-now-relay URL
  onSubscribe: (sub) => console.log("subscribed", sub.endpoint),
})

await psh.promptForPermission()       // asks, then subscribes
await psh.setTags({ tier: "pro" })    // optional segmentation
await psh.setExternalId("user-42")    // optional caller-side id
await psh.unsubscribe()
```

## The whole API

| Method | What it does |
|---|---|
| `promptForPermission()` | asks for permission, subscribes on grant |
| `subscribe()` | subscribes with existing permission |
| `unsubscribe()` | unsubscribes and tells the relay |
| `setTags(map)` | segmentation tags |
| `setExternalId(id)` | attach a caller-side id |
| `isSupported()` | true when web push works here |

## The whole contract

Your relay serves:

```
GET  /api/v1/vapid-key?siteKey=pk_…   → { vapidPublicKey }
POST /api/v1/subscribe                → { siteKey, endpoint, p256dhKey, authKey, userAgent }
POST /api/v1/unsubscribe              → { siteKey, endpoint }
POST /api/v1/tags                     → { siteKey, endpoint, tags }
POST /api/v1/identify                 → { siteKey, endpoint, externalId }
POST /api/v1/track                    → { event, siteKey?, url }
```

Your relay sends pushes as JSON:

```json
{
  "title": "Ship it",
  "body": "optional",
  "icon": "/icon-192.png",
  "badge": "/badge-72.png",
  "tag": "optional dedupe tag",
  "data": { "url": "/", "apiUrl": "https://psh.now", "siteKey": "pk_your-site" }
}
```

`data.apiUrl` is where the service worker sends impression/click/dismiss beacons
, each deployment's pushes route tracking to itself. `data.url` is where a
click lands.

## Design

- No storage layer: nothing is queued in the client, nothing persists between
  sessions. Tracking beacons are best-effort (`keepalive` fetches).
- The service worker reads its config from the push payload itself, so there
  is no cross-context handshake to keep in sync.
- A site decides when to ask; the SDK ships no UI.

MIT licensed. See LICENSE.
