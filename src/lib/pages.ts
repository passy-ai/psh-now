/**
 * HTML pages, with a content stamp on their own assets.
 *
 * Cloudflare caches `.css`/`.js` **by extension** and rewrites the origin's
 * `cache-control` to `max-age=345600`, so a browser happily keeps yesterday's
 * stylesheet: a change ships and the owner still sees the old button, which is
 * exactly how a fixed layout reads as "you did not fix it" (owner, 2026-10-15:
 * "cmon"). The stamp is the newest asset mtime, so the URL itself changes when a
 * file does (`/styles.css?v=1760…`) and both the edge and the browser fetch it
 * fresh. The HTML carries `no-cache`, so the new URL always reaches the browser.
 *
 * Every page that serves an HTML file goes through `pageHtml()` - a page that
 * bypasses it links an unversioned stylesheet and quietly goes stale.
 */
const VERSIONED_ASSETS = [
  "public/styles.css",
  "public/app.js",
  "public/pair.js",
  // The marketing site ships its *own* copies (different bytes from the dashboard's),
  // and its app.js is the file that hands out the install prompt. Leave them out and
  // editing the landing-page prompt never moves the stamp, so Cloudflare's 4-day
  // `.js` cache keeps serving the old wording - the fix exists and nobody sees it.
  "website/styles.css",
  "website/app.js",
];
// Matches a root-absolute URL (`/styles.css`, `/website/app.js`) *and* the marketing
// pages' own relative form (`./styles.css`), which is what they carry on disk.
const VERSIONABLE = /(href|src)="((?:\.\/|\/)(?:website\/)?(?:styles\.css|app\.js|pair\.js))"/g;

/** Newest mtime of the versioned assets - the cache-busting stamp. */
export async function assetStamp(): Promise<string> {
  const times = await Promise.all(
    VERSIONED_ASSETS.map(async (f) => {
      const file = Bun.file(f);
      return (await file.exists()) ? await file.lastModified : 0;
    }),
  );
  return String(Math.max(...times));
}

/** Stamp every versioned asset URL in an HTML string with the newest asset mtime. */
export async function stampAssets(html: string): Promise<string> {
  const stamp = await assetStamp();
  return html.replace(VERSIONABLE, `$1="$2?v=${stamp}"`);
}

/**
 * Read an HTML file, stamp its asset URLs, and serve it uncached.
 *
 * `transform` runs last, on the stamped markup, so a route can add the head tags
 * only it knows about - a canonical URL, or `noindex` for app UI (see lib/seo).
 */
export async function pageHtml(
  path: string,
  transform?: (html: string) => string,
): Promise<Response> {
  const stamped = await stampAssets(await Bun.file(path).text());
  return new Response(transform ? transform(stamped) : stamped, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}
