/**
 * Minified CSS and JS, built at boot.
 *
 * The stylesheet went over the wire at 71 KB and `app.js` at 16 KB, comments and
 * indentation included. Lighthouse charged 34 KiB of "unminified CSS" and 11 KiB of
 * "unminified JavaScript" for it on every page.
 *
 * Done here rather than as a build step so there is no second copy of the site to keep
 * in sync: the files on disk stay readable, and the minified form is produced from them
 * at startup.
 *
 * Two Bun quirks are worked around, both verified before this was written:
 *
 *   - `Bun.build` rewrites `unicode-range: U+0000-00FF` to `U0-0FF`, silently dropping
 *     the font's range. Substituting the `+` for a sentinel before the build and putting
 *     it back after keeps the declaration intact (45,047 bytes, range valid, font URL
 *     still relative).
 *   - `Bun.build` resolves `import ... from "/vendor/pickr/..."` as a filesystem path and
 *     fails; listing the vendor directory as `external` leaves the import untouched.
 *
 * esbuild did both correctly and was used first, but it is only reachable as a
 * transitive dependency of `drizzle-kit`, which is a devDependency - it is absent from a
 * production `bun install`, so the deployed image would have fallen back to unminified
 * files. Bun is the runtime we already ship.
 */
import { tmpdir } from "node:os";
import { stampCss } from "./pages";

/**
 * Files worth shrinking. The `?v=<mtime>` stamp already busts the cache when one of
 * these changes, so a rebuilt process can never serve a minified body under a URL that
 * promised the old one.
 */
const TARGETS = [
  "website/styles.css",
  "website/app.js",
  "website/notch-demo.css",
  "website/notch-demo.js",
  "public/styles.css",
  "public/app.js",
  "public/pair.js",
] as const;

/** Stands in for the `+` in `U+0000-00FF` while the minifier is running. */
const PLUS = "PSHUNICODEPLUS";

/** Built on first request, then reused for the life of the process. */
const built = new Map<string, string>();

/** Paths that have a minified form available. */
export function isMinifiable(path: string): boolean {
  return (TARGETS as readonly string[]).includes(path.replace(/^\.?\//, ""));
}

/**
 * The minified body for a file, or null when it has none or minification failed.
 *
 * A failure returns null rather than throwing: a server that will not start because a
 * stylesheet would not parse is worse than a server sending it unminified.
 */
export async function minified(path: string): Promise<string | null> {
  const key = path.replace(/^\.?\//, "");
  // Only the files in `TARGETS` are text. Without this guard every asset - fonts, PNGs,
  // icons - was handed to a JavaScript parser, which logged a parse error for each one.
  if (!isMinifiable(key)) return null;

  const hit = built.get(key);
  if (hit !== undefined) return hit;

  const source = Bun.file(key);
  if (!(await source.exists())) return null;

  const isCss = key.endsWith(".css");
  const text = await source.text();
  // `Bun.build` reads from disk, so the shielded source has to be written somewhere. The
  // OS temp directory is used rather than the project root so a crash mid-build cannot
  // leave a file behind in the repository or the image.
  const entry = `${tmpdir()}/psh-min-${Bun.hash(key).toString(36)}.${isCss ? "css" : "js"}`;

  try {
    await Bun.write(entry, isCss ? text.replaceAll("U+", `U${PLUS}`) : text);
    const result = await Bun.build({
      entrypoints: [entry],
      minify: true,
      target: "browser",
      // Nothing is bundled: these are absolute URLs the browser resolves, and treating
      // them as filesystem paths makes the build fail on a file it cannot find.
      external: ["/vendor/*", "*.woff2", "*.woff", "*.svg", "*.png", "*.jpg", "*.webp"],
    });
    if (!result.success) {
      console.error(`[minify] ${key}: ${result.logs.map(String).join("; ")}`);
      return null;
    }

    const output = result.outputs[0];
    if (!output) {
      console.error(`[minify] ${key}: the build produced no output`);
      return null;
    }
    let code = await output.text();
    if (isCss) {
      code = code.replaceAll(`U${PLUS}`, "U+");
      // The stylesheet's font URLs carry the asset stamp, so a font can be cached for the
      // same year as the CSS pointing at it.
      code = await stampCss(code);
    }
    built.set(key, code);
    return code;
  } catch (error) {
    console.error(`[minify] ${key}: ${(error as Error).message}`);
    return null;
  } finally {
    await Bun.file(entry).delete().catch(() => {});
  }
}
