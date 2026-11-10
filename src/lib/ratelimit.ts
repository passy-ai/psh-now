/**
 * Tiny in-process fixed-window rate limiter.
 *
 * Good enough for a single node (which is how psh.now runs). A multi-instance
 * deployment would move this to Redis/Postgres, but the goal here is blunt:
 * stop token/code brute-forcing and mint abuse on the public endpoints.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Returns true when the call is allowed; false when it should be rejected. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** Best-effort client id: proxy header first, then the socket address. */
export function clientId(headers: Headers, socketAddress?: string | null): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || socketAddress || "unknown";
}

// Drop stale buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref?.();
