import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "es2020",
    treeshake: true,
    minify: false,
  },
  {
    entry: { "service-worker": "src/sw-global.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "es2020",
    external: [],
  },
  {
    entry: { "browser/psh": "src/index.ts" },
    format: ["iife"],
    globalName: "Psh",
    outDir: "dist",
    target: "es2020",
    noExternal: [/.*/],
  },
  {
    entry: { "browser/psh-sw": "src/sw-entry.ts" },
    format: ["iife"],
    outDir: "dist",
    target: "es2020",
    noExternal: [/.*/],
  },
]);
