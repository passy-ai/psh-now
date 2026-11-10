/**
 * A very small, short-lived memo for hot lookups.
 *
 * The dashboard resolves the same API key four or five times per page load (tenant, key
 * scope, device, channel), and each resolution is a database round trip. Against a local
 * Postgres that is free; against a database a tunnel away it is 0.8 seconds a piece, which
 * is how a page load reached eleven seconds. Two seconds of staleness on a key lookup is
 * not a security decision: revocation is still bounded by the TTL, and every write path
 * that revokes also runs in this process, so the window is the TTL rather than a guess.
 */
interface Entry {
  value: unknown;
  at: number;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 500;

export async function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry | undefined;
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value as T;

  const value = await load();
  store.set(key, { value, at: Date.now() });

  if (store.size > MAX_ENTRIES) {
    for (const [k, v] of store) {
      if (now - v.at >= ttlMs) store.delete(k);
    }
  }
  return value;
}

/** Drop one key: for the paths that revoke or rewrite something mid-request. */
export function forget(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
