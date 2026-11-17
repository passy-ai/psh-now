// psh SDK, public types and the wire contract.
//
// The contract is deliberately tiny: one client class, one service worker,
// five HTTP calls. Every server that speaks /api/v1 (psh.now, psh-now-relay)
// works with every client that uses this SDK.

export interface PshConfig {
  /** Public site key (pk_…). Identifies the caller to the relay. */
  siteKey: string;
  /** Base URL of the relay. Default: https://psh.now */
  apiUrl?: string;
  /** Verbose console logging. Default: false */
  debug?: boolean;
  onSubscribe?: (subscription: PushSubscriptionJSON) => void;
  onPermissionDenied?: () => void;
  onNotSupported?: () => void;
  onNotificationClick?: (url: string) => void;
}

export interface PshInstance {
  /** Ask the user for notification permission, then subscribe. */
  promptForPermission(): Promise<PushSubscriptionJSON | null>;
  /** Subscribe with existing permission. */
  subscribe(): Promise<PushSubscriptionJSON | null>;
  /** Unsubscribe and tell the relay. */
  unsubscribe(): Promise<void>;
  /** Segmentation tags. */
  setTags(tags: Record<string, string>): Promise<void>;
  /** Attach a caller-side id (user id, agent id, …). */
  setExternalId(externalId: string): Promise<void>;
  /** True when this browser can do web push. */
  isSupported(): boolean;
}

/** Wire shape of a push message (server → service worker). */
export interface PushPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  /** When true the SW replaces a visible notification with the same tag. */
  renotify?: boolean;
  data?: { url?: string; apiUrl?: string; siteKey?: string };
}

export const DEFAULT_API_URL = "https://psh.now";
