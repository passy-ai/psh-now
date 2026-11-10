/**
 * Minimal static server for the psh.now homepage preview.
 *
 * Deliberately standalone: it serves `website/` at `/` on its OWN port and
 * never imports from `src/` or touches the main gateway, so it can run
 * alongside `bun src/index.ts` (and the `pshyweb` zrok tunnel) safely.
 *
 *   bun website/serve.ts            # http://localhost:4322
 *   WEBSITE_PORT=5000 bun website/serve.ts
 */
const root = import.meta.dir;
const port = Number(process.env.WEBSITE_PORT ?? 4322);
const hostname = process.env.WEBSITE_HOST ?? "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path === "/") path = "/index.html";
    if (path.includes("..")) return new Response("Not found", { status: 404 });

    let file = Bun.file(`${root}${path}`);
    // Extensionless routes serve the .html file (/privacy -> privacy.html).
    if (!(await file.exists()) && !path.includes(".")) {
      file = Bun.file(`${root}${path}.html`);
    }
    if (!(await file.exists())) return new Response("Not found", { status: 404 });

    return new Response(file, {
      headers: {
        "cache-control": "no-store, must-revalidate",
        pragma: "no-cache",
        expires: "0",
      },
    });
  },
});

console.log(`psh.now homepage → http://localhost:${server.port}`);
