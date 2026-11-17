// Fails the build if dist and package.json disagree.
//
// They did disagree: the build renamed tsup's `.global.js` bundles to `.js`, while the
// export map, the README and @psh/relay all asked for `.global.js`. Nothing caught it
// because nobody imported the subpath here, and the break would only surface after
// publish, in someone else's bundler.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const targets = [];
const walk = (value, path) => {
  if (typeof value === "string") targets.push([path, value]);
  else if (value && typeof value === "object") for (const key in value) walk(value[key], `${path}/${key}`);
};
for (const key in pkg.exports ?? {}) walk(pkg.exports[key], key);
for (const key of ["main", "module", "types"]) if (pkg[key]) targets.push([key, pkg[key]]);

const missing = targets.filter(([, file]) => !existsSync(resolve(root, file)));
for (const [key, file] of targets) console.log(`${missing.some(([k]) => k === key) ? "MISSING" : "ok     "} ${key} ${file}`);
if (missing.length) {
  console.error(`\n${missing.length} export target(s) missing from dist. Run the build, or fix package.json.`);
  process.exit(1);
}
console.log(`\nall ${targets.length} export targets exist`);
