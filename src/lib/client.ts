/**
 * Where a request came from, for the device records on the Devices page.
 *
 * psh.now sits behind a Cloudflare tunnel, so Cloudflare's own headers are the
 * most reliable source: `cf-connecting-ip` is the real client, while
 * `x-forwarded-for` is what we see locally or behind any other proxy.
 */

/** The visitor's address, or null when nothing in the chain reports one. */
export function clientIp(headers: Headers): string | null {
  const direct = headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct;

  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  return null;
}

/**
 * Cloudflare's two-letter country code for the visitor, or null. Cloudflare
 * sends `XX` when it cannot tell and `T1` for Tor, neither of which is a place.
 */
export function clientCountry(headers: Headers): string | null {
  const code = headers.get("cf-ipcountry")?.trim().toUpperCase();
  if (!code || code.length !== 2 || code === "XX" || code === "T1") return null;
  return code;
}

/** Both at once, for callers that store a whole "connected from" record. */
export function clientOrigin(headers: Headers): { ip: string | null; country: string | null } {
  return { ip: clientIp(headers), country: clientCountry(headers) };
}
