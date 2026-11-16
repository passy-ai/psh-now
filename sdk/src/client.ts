// psh SDK — browser client.
//
// Own implementation. Talk to a /api/v1 relay: fetch the relay's VAPID public
// key, subscribe the browser, post the subscription back, and let the site
// opt into tags / external ids. No storage layer, no retry queues, no banner:
// the site decides when and how to ask.

import {
  DEFAULT_API_URL,
  type PshConfig,
  type PshInstance,
} from "./types";

const log = (debug: boolean | undefined, ...args: unknown[]) => {
  if (debug) console.log("[psh]", ...args);
};

/** VAPID keys are base64url; the browser wants raw bytes. */
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = (4 - (b64.length % 4)) % 4;
  const s = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export async function registerServiceWorker(url: string): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(url);
}

async function post(apiUrl: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`psh: ${path} → ${res.status}`);
}

export class PshClient implements PshInstance {
  private siteKey: string;
  private apiUrl: string;
  private debug: boolean;
  private swUrl: string;
  private registration: ServiceWorkerRegistration | null = null;
  private tags: Record<string, string> = {};
  private externalId: string | null = null;
  private cfg: PshConfig;

  constructor(cfg: PshConfig) {
    this.cfg = cfg;
    this.siteKey = cfg.siteKey;
    this.apiUrl = (cfg.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.debug = cfg.debug ?? false;
    this.swUrl = `${this.apiUrl}/psh-sw.js`;
    log(this.debug, "ready", { siteKey: this.siteKey, apiUrl: this.apiUrl });
  }

  isSupported(): boolean {
    return isPushSupported();
  }

  setTags(tags: Record<string, string>): Promise<void> {
    this.tags = { ...this.tags, ...tags };
    return this.postIdentity("/api/v1/tags", { tags: this.tags });
  }

  setExternalId(externalId: string): Promise<void> {
    this.externalId = externalId;
    return this.postIdentity("/api/v1/identify", { externalId });
  }

  private async postIdentity(path: string, extra: object): Promise<void> {
    const reg = await this.getRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await post(this.apiUrl, path, {
      siteKey: this.siteKey,
      endpoint: sub.endpoint,
      ...extra,
    });
  }

  private async getRegistration(): Promise<ServiceWorkerRegistration> {
    if (!this.registration) {
      if (!isPushSupported()) throw new Error("psh: push not supported in this browser");
      this.registration = await registerServiceWorker(this.swUrl);
      log(this.debug, "service worker registered");
    }
    return this.registration;
  }

  async promptForPermission(): Promise<PushSubscriptionJSON | null> {
    if (!isPushSupported()) {
      this.cfg.onNotSupported?.();
      return null;
    }
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      log(this.debug, "permission denied");
      this.cfg.onPermissionDenied?.();
      return null;
    }
    return this.subscribe();
  }

  async subscribe(): Promise<PushSubscriptionJSON | null> {
    if (Notification.permission !== "granted") {
      this.cfg.onPermissionDenied?.();
      return null;
    }
    const reg = await this.getRegistration();
    const keyRes = await fetch(`${this.apiUrl}/api/v1/vapid-key?siteKey=${encodeURIComponent(this.siteKey)}`);
    if (!keyRes.ok) throw new Error(`psh: vapid-key → ${keyRes.status}`);
    const { vapidPublicKey } = (await keyRes.json()) as { vapidPublicKey: string };

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
    });

    const json = sub.toJSON();
    await post(this.apiUrl, "/api/v1/subscribe", {
      siteKey: this.siteKey,
      endpoint: json.endpoint,
      p256dhKey: json.keys?.p256dh,
      authKey: json.keys?.auth,
      userAgent: navigator.userAgent,
    });
    log(this.debug, "subscribed", json.endpoint);
    this.cfg.onSubscribe?.(json);
    return json;
  }

  async unsubscribe(): Promise<void> {
    const reg = await this.getRegistration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await post(this.apiUrl, "/api/v1/unsubscribe", {
      siteKey: this.siteKey,
      endpoint: sub.endpoint,
    }).catch(() => undefined);
    await sub.unsubscribe();
    log(this.debug, "unsubscribed");
  }
}

export function createPsh(cfg: PshConfig): PshInstance {
  return new PshClient(cfg);
}
