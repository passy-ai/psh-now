/**
 * The site, generated once instead of assembled per request.
 *
 * A marketing page used to be rebuilt on the way out: read the file, run the asset stamp
 * over it, rewrite its relative links, inject the canonical and Open Graph tags. That is
 * four passes over a whole document for bytes that change when a file on disk changes and
 * at no other time - and the work landed on whichever request happened to arrive first.
 *
 * `builtHtml()` memoises that per page, keyed by the page's own mtime and the shared asset
 * stamp, so the build is a cache and not a second copy of the site. This module runs it
 * for every page at boot instead of waiting for a visitor: `prebuildPages()` walks
 * `PAGE_FILES`, the table the sitemap is generated from. One list, so a page cannot be
 * indexed without also being built, and cannot be built without being indexed.
 *
 * What is deliberately *not* baked into the repository: the canonical and Open Graph
 * origin come from `PUBLIC_BASE_URL`, so a self-hosted install must not advertise psh.now
 * as its canonical, and the asset stamp is the newest mtime, which only means something on
 * the machine holding the files. Both are settled at boot, on the host that serves them.
 */
import { builtHtml } from "./pages";
import { canonicalPath, injectSeo, PAGE_FILES, rewriteRelative } from "./seo";

/**
 * A page from the table, built the way its route builds it.
 *
 * The marketing pages carry relative links (`./index.html`, `./styles.css`) that have to
 * be rewritten to their canonical addresses; the two under `public/` already use absolute
 * ones. Both get the stamp and the head tags.
 */
function build(file: string): Promise<string> {
  return builtHtml(file, (html) => {
    const rel = file.replace(/^(website|public)\//, "");
    const canonical = canonicalPath(rel) ?? `/${rel.replace(/\.html$/, "")}`;
    return file.startsWith("website/")
      ? injectSeo(rewriteRelative(html), canonical)
      : injectSeo(html, canonical);
  });
}

/**
 * A marketing page, ready to send: stamped, links rewritten, head tags added.
 *
 * `rel` is the file name under `website/` (`teams.html`, `agents/cursor.html`). Returns
 * null for a file that is not there, which is how an unknown agent slug stays a 404.
 */
export async function marketingPage(rel: string): Promise<string | null> {
  const file = `website/${rel}`;
  if (!(await Bun.file(file).exists())) return null;
  return build(file);
}

/** A documentation page, which lives under `public/` rather than `website/`. */
export function docsPage(file: string): Promise<string> {
  return build(file);
}

/**
 * Generate every page, before anyone asks for one.
 *
 * Failures are logged and counted, not thrown: a page that will not build should cost
 * that page, not the boot of the server that also answers the API.
 */
export async function prebuildPages(): Promise<{ built: number; failed: number; ms: number }> {
  const started = performance.now();
  const results = await Promise.all(
    PAGE_FILES.map((page) =>
      build(page.file).catch((err) => {
        console.error(`[static] ${page.file}:`, err);
        return null;
      }),
    ),
  );
  return {
    built: results.filter((html) => html !== null).length,
    failed: results.filter((html) => html === null).length,
    ms: Math.round(performance.now() - started),
  };
}
