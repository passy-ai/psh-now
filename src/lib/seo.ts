/**
 * Search-engine metadata and crawler files, generated from one origin.
 *
 * `env.publicBaseUrl` is the only place this site states its own address, but the
 * marketing HTML also spelled that address out by hand, as `https://psh.now`. That
 * host has no DNS record, so every page advertising it as its canonical was
 * pointing at somewhere that does not resolve. A canonical aimed at a dead host is
 * worse than no canonical at all: it tells a crawler the real page lives somewhere
 * it cannot reach, which is how a site falls out of the index while still
 * answering 200 to a browser.
 *
 * So the origin is stated once, and the tags below are derived from it. Titles and
 * descriptions stay in the HTML, where an author edits the actual words.
 */
import { env } from "../env";

const base = env.publicBaseUrl;

export const SITE_NAME = "psh.now";

/** Used only when a page carries no description of its own. */
export const SITE_DESCRIPTION =
  "psh.now is the human-approval hub for AI agents: the agent asks from the terminal, phone, or sandbox, and a person taps Approve or Deny.";

/** The social preview card (1200x630). */
const OG_IMAGE = `${base}/website/og.png`;

/**
 * The pages worth indexing, in sitemap order.
 *
 * `rel` is the file name under `website/`, which is how the marketing routes
 * address these pages: `/privacy` and `/website/privacy.html` serve the same
 * bytes, so they have to agree on one canonical or they compete with each other.
 */
const PAGES = [
  { rel: "index.html", path: "/", file: "website/index.html", priority: "1.0", changefreq: "weekly" },
  { rel: "docs.html", path: "/docs", file: "public/docs.html", priority: "0.9", changefreq: "weekly" },
  { rel: "teams.html", path: "/teams", file: "website/teams.html", priority: "0.8", changefreq: "monthly" },
  { rel: "alternatives.html", path: "/alternatives", file: "website/alternatives.html", priority: "0.8", changefreq: "monthly" },
  { rel: "self-hosting.html", path: "/self-hosting", file: "public/self-hosting.html", priority: "0.7", changefreq: "monthly" },
  { rel: "privacy.html", path: "/privacy", file: "website/privacy.html", priority: "0.3", changefreq: "yearly" },
  { rel: "terms.html", path: "/terms", file: "website/terms.html", priority: "0.3", changefreq: "yearly" },
] as const;

/** The one canonical path for a marketing file, or null if it is not an indexed page. */
export function canonicalPath(rel: string): string | null {
  return PAGES.find((p) => p.rel === rel)?.path ?? null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hasTag(html: string, pattern: RegExp): boolean {
  return pattern.test(html);
}

/** The title and description exactly as the page file itself states them. */
function readMeta(html: string): { title: string; description: string } {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/is)?.[1]?.trim() || SITE_NAME;
  const description =
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/is)?.[1]?.trim() || SITE_DESCRIPTION;
  return { title, description };
}

/**
 * The canonical, Open Graph, and Twitter tags for a page.
 *
 * Derived from the page's own `<title>` and description, so an author keeps
 * editing the words in the file and cannot drift from what is advertised.
 */
export function seoHead(html: string, path: string, robots?: string): string {
  const { title, description } = readMeta(html);
  const url = path === "/" ? `${base}/` : `${base}${path}`;
  const t = esc(title);
  const d = esc(description);
  return [
    robots ? `<meta name="robots" content="${esc(robots)}" />` : "",
    // Only supply a description when the page does not already carry one; two
    // competing descriptions on a page is a coin toss for a crawler.
    hasTag(html, /<meta\s+name="description"/i) ? "" : `<meta name="description" content="${d}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${OG_IMAGE}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${OG_IMAGE}" />`,
    path === "/" ? `<script type="application/ld+json">${JSON.stringify(softwareLd(html)).replace(/</g, "\\u003c")}</script>` : "",
  ]
    .filter(Boolean)
    .join("\n    ");
}

/** The homepage's structured data, derived from the page so it cannot drift. */
function softwareLd(html: string): Record<string, unknown> {
  const { description } = readMeta(html);
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    description,
    url: `${base}/`,
    license: `${base}/license`,
    isAccessibleForFree: true,
    offers: [{ "@type": "Offer", price: "0", priceCurrency: "EUR", name: "Self hosted" }],
    publisher: { "@type": "Organization", name: "Absolum", url: `${base}/` },
  };
}

/** Insert the generated tags into a page's head. */
export function injectSeo(html: string, path: string, robots?: string): string {
  if (!html.includes("</head>")) return html;
  return html.replace("</head>", `  ${seoHead(html, path, robots)}\n  </head>`);
}

/**
 * Keep app UI out of the index.
 *
 * `/app`, `/login`, and the pairing pages are signed-in views behind a gate, not
 * content: indexing them puts an empty "Log in" screen in search results and
 * splits ranking signals away from the pages that should have them.
 */
export function injectNoIndex(html: string): string {
  if (hasTag(html, /<meta\s+name="robots"/i) || !html.includes("</head>")) return html;
  return html.replace("</head>", `  <meta name="robots" content="noindex, nofollow" />\n  </head>`);
}

/**
 * Sibling files that have a clean URL of their own.
 *
 * A link between two marketing pages should point at the canonical address
 * (`/privacy`), not the asset path (`/website/privacy.html`): the crawler follows
 * one URL instead of discovering a duplicate.
 */
const CANONICAL_REFS: Record<string, string> = {
  "./index.html": "/",
  "./docs.html": "/docs",
  "./privacy.html": "/privacy",
  "./terms.html": "/terms",
  "./llms.txt": "/llms.txt",
};

const CANONICAL_REF =
  /(href|src)="(\.\/(?:index|docs|privacy|terms)\.html|\.\/llms\.txt)"/g;

/**
 * Rewrite a marketing page's `./x` references so the page survives being served
 * from a clean URL: assets and every other sibling file move under `/website/`,
 * while links between pages go straight to their canonical address.
 */
export function rewriteRelative(html: string): string {
  return html
    .replace(CANONICAL_REF, (_match, attr: string, ref: string) => `${attr}="${CANONICAL_REFS[ref]}"`)
    .replaceAll('href="./', 'href="/website/')
    .replaceAll('src="./', 'src="/website/');
}

/**
 * Paths that are not content, whatever a crawler might make of them.
 *
 * Every one of these answers only to a signed-in user or a token, so a crawler
 * that follows them either sees a login gate or burns its budget on links that
 * were never meant to be public.
 */
const DISALLOW = [
  "/api/",
  "/app",
  "/login",
  "/devices",
  "/claim",
  "/pair/",
  "/join/",
  "/invite/",
  "/c/",
  "/j/",
];

/**
 * robots.txt.
 *
 * Content is open to every crawler, AI agents included; that is the point of
 * /llms.txt, and a blanket `User-agent: *` already covers them, so there is no
 * need for a block per crawler.
 */
export function robotsTxt(): string {
  return [
    "# psh.now",
    "# Content is open to every crawler, AI agents included. See /llms.txt.",
    "",
    "User-agent: *",
    "Allow: /",
    ...DISALLOW.map((p) => `Disallow: ${p}`),
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * sitemap.xml.
 *
 * `lastmod` is the real file mtime rather than the generation time: a sitemap
 * that claims every page changed today, every day, is one crawlers learn to
 * ignore.
 */
export async function sitemapXml(): Promise<string> {
  const urls = await Promise.all(
    PAGES.map(async (page) => {
      const file = Bun.file(page.file);
      const lastmod = (await file.exists())
        ? new Date(await file.lastModified).toISOString().slice(0, 10)
        : null;
      return [
        "  <url>",
        `    <loc>${base}${page.path}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : "",
        `    <changefreq>${page.changefreq}</changefreq>`,
        `    <priority>${page.priority}</priority>`,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
