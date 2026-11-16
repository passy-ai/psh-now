// psh SDK — service worker (the one that receives pushes).
//
// Own implementation, minimal by design:
//   push  → show the notification, send an impression beacon
//   click → send a click beacon, open data.url
// Tracking is best-effort (keepalive fetch); nothing is queued or stored.
// The payload carries apiUrl, so every message routes tracking to its own relay.

import type { PushPayload } from "./types";

declare const self: ServiceWorkerGlobalScope & { __PSH_CONFIG__?: { apiUrl?: string } };

function track(apiUrl: string, event: string, data: PushPayload["data"], url?: string): void {
  try {
    void fetch(`${apiUrl}/api/v1/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ event, siteKey: data?.siteKey, url }),
    });
  } catch {
    /* best-effort */
  }
}

function apiUrlOf(payload: PushPayload): string {
  const fromPayload = payload?.data?.apiUrl;
  if (fromPayload) return fromPayload;
  const cfg = (self as { __PSH_CONFIG__?: { apiUrl?: string } }).__PSH_CONFIG__;
  if (cfg?.apiUrl) return cfg.apiUrl;
  return self.registration.scope.replace(/\/+$/, "").replace(/^.*\/\/[^/]+/, "") || "";
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload: PushPayload = { title: "psh" };
  try {
    if (event.data) payload = event.data.json() as PushPayload;
  } catch {
    if (event.data) payload = { title: "psh", body: event.data.text() };
  }
  track(apiUrlOf(payload), "impression", payload.data);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      data: payload.data ?? {},
      // renotify is valid at runtime; TS's NotificationOptions omits it.
      ...(payload.renotify ? { renotify: true } : {}),
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as PushPayload["data"];
  const url = data?.url ?? "/";
  track(apiUrlOf({ data } as PushPayload), "click", data, url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("notificationclose", (event) => {
  const data = (event.notification.data ?? {}) as PushPayload["data"];
  track(apiUrlOf({ data } as PushPayload), "dismiss", data);
});
