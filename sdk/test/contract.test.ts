// psh SDK — unit tests for our own primitives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { urlBase64ToUint8Array } from "../src/client";
import { VERSION } from "../src/index";
import { DEFAULT_API_URL } from "../src/types";

test("base64url → bytes: 65-byte P-256-style key round-trips", () => {
  const keyBytes = new Uint8Array(65);
  keyBytes[0] = 0x04; // uncompressed EC point
  for (let i = 1; i < 65; i++) keyBytes[i] = i;
  const b64url = Buffer.from(keyBytes).toString("base64url"); // unpadded, urlsafe
  const out = urlBase64ToUint8Array(b64url);
  assert.equal(out.length, 65);
  assert.deepEqual([...out], [...keyBytes]);
});

test("base64url → bytes: padded and unpadded agree", () => {
  const a = new TextDecoder().decode(urlBase64ToUint8Array("SGVsbG8"));
  const b = new TextDecoder().decode(urlBase64ToUint8Array("SGVsbG8="));
  assert.equal(a, "Hello");
  assert.equal(a, b);
});

test("base64url → bytes: urlsafe alphabet (- _) matches standard decode", () => {
  const u = urlBase64ToUint8Array("-_-_");
  assert.deepEqual([...u], [...Buffer.from("-_-_", "base64url")]);
});

test("default relay is psh.now", () => {
  assert.equal(DEFAULT_API_URL, "https://psh.now");
});

test("VERSION matches package.json, so a page can report what it is running", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});
