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
  // Renames the header's two buttons for a signed-in visitor. Small, and changes as often
  // as the copy does, so it needs the stamp like the rest.
  "website/viewer.js",
  // The notch, drawn: shared by the homepage section and /notch, so an edit to either
  // file has to move the stamp too or the CDN keeps serving the old panel.
  "website/notch-demo.css",
  "website/notch-demo.js",
  // Fonts and icons are stamped too. Without a stamp they could only be cached for a day,
  // and Lighthouse charged that as "efficient cache lifetimes" on every page. The fonts are
  // referenced from the stylesheet rather than the markup, so `stampCss()` covers those.
  "website/fonts/inter-latin.woff2",
  "website/fonts/geist-latin.woff2",
  "website/fonts/geist-mono-latin.woff2",
  "website/psh-mark.svg",
];
// Matches a root-absolute URL (`/styles.css`, `/website/app.js`) *and* the marketing
// pages' own relative form (`./styles.css`), which is what they carry on disk.
const VERSIONABLE =
  /(href|src)="((?:\.\/|\/)(?:website\/)?(?:styles\.css|app\.js|viewer\.js|pair\.js|notch-demo\.css|notch-demo\.js|psh-mark\.svg|agenticons\/[a-z-]+\.svg|fonts\/[a-z-]+\.woff2))"/g;

/** The stylesheet's own `url(./fonts/x.woff2)` references, stamped the same way. */
const CSS_FONTS = /url\((["']?)(\.\/fonts\/[a-z-]+\.woff2)\1\)/g;

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
 * The same stamp, for the stylesheet's `url(./fonts/x.woff2)` references.
 *
 * A font cached for a day is a revalidation on the second visit, which Lighthouse counts
 * against "efficient cache lifetimes" on every page that uses one. With a stamp in the
 * URL the file is immutable and can be cached for a year like the CSS referencing it.
 */
export async function stampCss(css: string): Promise<string> {
  const stamp = await assetStamp();
  return css.replace(
    CSS_FONTS,
    (_match, quote: string, path: string) => `url(${quote}${path}?v=${stamp}${quote})`,
  );
}

/**
 * The assembled HTML, kept until the file or an asset changes.
 *
 * A page's bytes change when a file on disk changes and at no other time, so building
 * them per request spent three passes over the document on work that was already done -
 * and made the first request after a deploy pay for all of it. The key is the page's own
 * mtime plus the shared asset stamp, which is exactly `signature()`, so an edit on a dev
 * machine is picked up on the next request and a production process builds each page once.
 */
const built = new Map<string, { html: string; key: string }>();

/** Everything that can change a page's bytes: its own file, and every stamped asset. */
export async function signature(file: string): Promise<string> {
  const handle = Bun.file(file);
  const mtime = (await handle.exists()) ? await handle.lastModified : 0;
  return `${mtime}:${await assetStamp()}`;
}

/**
 * Read an HTML file and return it with its assets stamped, building it once per change.
 *
 * `transform` runs last, on the stamped markup, so a route can add the head tags only it
 * knows about - a canonical URL, or `noindex` for app UI (see lib/seo). It must therefore
 * be a pure function of the markup and the file it came from: two routes that pass
 * different transforms for the same file would share one cache entry.
 */
export async function builtHtml(
  path: string,
  transform?: (html: string) => string,
): Promise<string> {
  const key = await signature(path);
  const hit = built.get(path);
  if (hit && hit.key === key) return hit.html;
  const stamped = await stampAssets(await Bun.file(path).text());
  const html = transform ? transform(stamped) : stamped;
  built.set(path, { html, key });
  return html;
}

/** A document, with the headers every HTML route in this app sends. */
export function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/**
 * The same, as a response: HTML, uncached at the edge.
 *
 * `no-cache` because the markup names the current asset stamp: the browser should ask
 * again so a new deploy reaches it, and the answer is cheap now that it is a string.
 */
export async function pageHtml(
  path: string,
  transform?: (html: string) => string,
): Promise<Response> {
  return htmlResponse(await builtHtml(path, transform));
}
