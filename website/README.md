# psh.now homepage (`/website`)

A static, standalone homepage for **psh.now**, the hub for agents that need you,
modeled closely on the [here.now](https://here.now) landing page (same layout,
typography, spacing, light/dark theme, CTA, and FAQ patterns).

Everything here is self-contained, no build step, no framework, no external
CDNs. Fonts and agent icons are vendored into this folder.

`/llms.txt`, `/robots.txt`, and `/sitemap.xml` are **generated** by the gateway
(`src/lib/seo.ts`) rather than stored here, so the origin in them always matches
`PUBLIC_BASE_URL`. The canonical, Open Graph, and Twitter tags are generated the
same way: from each page's own `<title>` and description, do not hardcode them.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The homepage |
| `docs.html` | Minimal docs stub (so nav links don't 404) |
| `privacy.html`, `terms.html` | Privacy policy and terms (`/privacy`, `/terms`) |
| `styles.css` | All styles, incl. light/dark theme via `prefers-color-scheme` |
| `app.js` | Agent row, "Copy prompt for agent", scroll reveals |
| `serve.ts` | Standalone static server (`bun website/serve.ts`) |
| `psh-mark.svg` | Monochrome brand mark (inverts in dark mode) |
| `favicon.svg` | Favicon |
| `fonts/` | Inter (page text) + Geist (glyph fallback) + Geist Mono (latin subset, `woff2`) |
| `agenticons/` | Agent logos for the "Works with every agent" row |

## View it

Locally:

```bash
cd website
python3 -m http.server 8899   # or: bun serve.ts  →  http://localhost:4322
# open http://localhost:8899
```

## Serve it at `/` (own port + own zrok share)

This is fully additive, it does **not** touch the main gateway
(`bun src/index.ts`), its routes, or the existing `pshyweb` zrok tunnel:

```bash
```

- Static server: `http://localhost:4322` (override with `WEBSITE_PORT`)
- Public URL: **https://pshhome.share.zrok.io** (override with `ZROK_WEBSITE_SHARE`)

It is idempotent: the server and the reserved share are only started if they
aren't already running. Logs land in `/tmp/psh-website.log` and
`/tmp/zrok-website.log`.

## Notes

- **Positioning:** the copy leads with the core pain (agents stalling at the
  terminal) and the fix: one hub where you or a teammate **approve, deny, or
  clarify** from any device. Hero, how-it-works, feature tabs, team section,
  testimonials, FAQ and CTA all follow that narrative.
- **White mode is forced**: the page ignores the OS dark preference (verified
  with a dark system setting). The dark palette is still in `styles.css`; add
  `data-theme="dark"` to `<html>` to opt back in.
- The hero reads **"Never lose an agent / to a waiting prompt / in the
  terminal"**, with **"No account needed."** above the copy-prompt button, and a
  **chevron** below it that expands the full prompt text inline.
- The **feature tabs** (One hub / Any device / Team / Clarify / Agent-to-agent /
  Channels) are interactive: clicking one swaps the detail panel below it.
- A gradient **CTA** ("Try It With Your Own Agents" / *Start for free*), contained
  to the page column, closes the page; its button copies the agent prompt.
- The header, main content and footer share one boundary (`--page-max` /
  `--page-pad`), so the navbar items line up with the content column.
- Body copy, feature cards, FAQ entries, and testimonials are placeholder
  content written for psh.now, swap in real copy/testimonials before shipping.
- The footer links to `Docs`, `llms.txt`, `Terms`, `Privacy`, and `Absolum`
  (https://absolum.nl). The server also maps extensionless routes
  (`/privacy` → `privacy.html`).
- Legal pages are intentionally short: psh.now processes approval requests only
  and deletes request data automatically once answered or timed out.
- This is a design preview only; `Log in` / `Sign up` links are inert.
