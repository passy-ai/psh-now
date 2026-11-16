// psh SDK — client surface: isPushSupported is false in node (no navigator SW).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPushSupported } from "../src/client";

test("isPushSupported() is false outside a browser", () => {
  assert.equal(isPushSupported(), false);
});
