// The product version has exactly one source of truth: the skill's frontmatter.
//
// It used to be written out by hand in three places, the OpenAPI document, the agent manifest and
// /api/skill/version, and they had already drifted ("0.1.0" everywhere while the skill said
// 0.2.1), so the API reference advertised a version the product did not have.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | null = null;

export function productVersion(): string {
  if (cached) return cached ?? "0.0.0";
  try {
    const path = join(import.meta.dir, "..", "..", "skills", "psh-now", "SKILL.md");
    const match = readFileSync(path, "utf8").match(/^version:\s*(\S+)\s*$/m);
    cached = match ? (match[1] ?? "0.0.0") : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached ?? "0.0.0";
}
