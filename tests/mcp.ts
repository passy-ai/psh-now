/**
 * MCP conformance: the JSON-RPC surface, the tool, and the failure paths.
 *
 *   DATABASE_URL=postgresql://... bun tests/mcp.ts
 *
 * Boots the real server on a random port and talks to it the way a client does.
 * A decision is recorded through the same HTTP endpoint the dashboard uses, so a
 * pass means the whole path held: frame in, prompt row, decision, boolean out.
 */

import { spawn } from "bun";

// Point PSH_BASE at a running host to run the same suite against it; otherwise this
// spawns its own server, which is what CI does.
const REMOTE = process.env.PSH_BASE?.replace(/\/$/, "") ?? null;
const PORT = 4900 + Math.floor(Math.random() * 200);
const BASE = REMOTE ?? `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  throw new Error("server did not become healthy");
}

interface RpcReply {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(
  payload: unknown,
  opts: { key?: string; raw?: string; method?: string } = {},
): Promise<{ status: number; body: RpcReply }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key) headers["x-psh-key"] = opts.key;
  const res = await fetch(`${BASE}/mcp`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.raw ?? JSON.stringify(payload),
  });
  const text = await res.text();
  let body: RpcReply = {};
  try {
    body = text ? (JSON.parse(text) as RpcReply) : {};
  } catch {
    body = { error: { code: 0, message: text.slice(0, 120) } };
  }
  return { status: res.status, body };
}

/** A workspace key, minted the same way an agent gets one. */
async function mintKey(): Promise<string> {
  const res = await fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "MCP test workspace", wait: false }),
  });
  const json = (await res.json()) as { apiKey?: string };
  if (!json.apiKey) throw new Error("no key minted");
  return json.apiKey;
}

async function pendingPrompts(key: string): Promise<Array<{ id: string; title: string }>> {
  const res = await fetch(`${BASE}/api/v1/approvals?status=pending`, {
    headers: { "x-psh-key": key },
  });
  const json = (await res.json()) as { prompts?: Array<{ id: string; title: string }> };
  return json.prompts ?? [];
}

async function decide(key: string, id: string, approved: boolean, answer?: string) {
  await fetch(`${BASE}/api/v1/approvals/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-psh-key": key },
    body: JSON.stringify(answer ? { approved, answer } : { approved }),
  });
}

/** Wait for the prompt with this title, then answer it. */
async function answerByTitle(key: string, title: string, approved: boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await pendingPrompts(key)).find((p) => p.title === title);
    if (found) {
      await decide(key, found.id, approved);
      return true;
    }
    await Bun.sleep(120);
  }
  return false;
}

function callTool(key: string | undefined, args: Record<string, unknown>, id = 1) {
  return rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "psh_ask", arguments: args } }, { key });
}

function toolPayload(reply: RpcReply): Record<string, unknown> {
  const content = (reply.result?.content as Array<{ text?: string }> | undefined) ?? [];
  const text = content[0]?.text ?? "{}";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Keep the body: a proxy error page or an HTML 5xx must be visible in the report.
    return { _raw: text.slice(0, 200) };
  }
}

const server = REMOTE
  ? null
  : spawn({
      // process.execPath is the bun that is running this file: bun is not always on PATH.
      cmd: [process.execPath, "src/index.ts"],
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        PUBLIC_BASE_URL: BASE,
        NODE_ENV: "test",
        PSH_ALLOW_LOCAL_ORIGIN: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

try {
  await waitForHealth();
  const key = await mintKey();

  console.log("\nprotocol");
  const get = await fetch(`${BASE}/mcp`);
  const getBody = (await get.json().catch(() => ({}))) as { transport?: { url?: string } };
  check("GET /mcp answers with the descriptor", get.status === 200 && getBody.transport?.url === `${BASE}/mcp`, `got ${get.status}`);

  const sse = await fetch(`${BASE}/mcp`, { headers: { accept: "text/event-stream" } });
  check("GET /mcp asking for SSE is 405 with Allow: POST", sse.status === 405 && sse.headers.get("allow") === "POST", `got ${sse.status}`);

  const bad = await rpc(null, { raw: "{not json" });
  check("invalid JSON is -32700", bad.body.error?.code === -32700, JSON.stringify(bad.body.error));

  const batch = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  check("a batch is refused with -32600", batch.body.error?.code === -32600);

  const notRpc = await rpc({ hello: "world" });
  check("a non JSON-RPC object is -32600", notRpc.body.error?.code === -32600);

  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  check("initialize echoes the requested version", init.body.result?.protocolVersion === "2025-06-18");
  check(
    "initialize advertises the tools capability",
    (init.body.result?.capabilities as { tools?: unknown } | undefined)?.tools !== undefined,
  );
  check(
    "initialize names the server",
    (init.body.result?.serverInfo as { name?: string } | undefined)?.name === "psh-now",
  );

  const initOld = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999-01-01", capabilities: {} },
  });
  check("an unknown version falls back to the newest", initOld.body.result?.protocolVersion === "2025-06-18");

  const notif = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("notifications/initialized is 202 with no body", notif.status === 202);

  const ping = await rpc({ jsonrpc: "2.0", id: 3, method: "ping" });
  check("ping returns an empty result", ping.body.result !== undefined && Object.keys(ping.body.result).length === 0);

  const unknown = await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  check("an unknown method is -32601", unknown.body.error?.code === -32601);

  console.log("\ntools");
  const list = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  const tools = (list.body.result?.tools as Array<{ name: string; inputSchema?: { required?: string[] } }>) ?? [];
  check("tools/list has exactly one tool", tools.length === 1, `got ${tools.length}`);
  check("the tool is psh_ask", tools[0]?.name === "psh_ask");
  check("message is required", (tools[0]?.inputSchema?.required ?? []).includes("message"));

  const noKey = await callTool(undefined, { message: "should not work" });
  check("no key is HTTP 401", noKey.status === 401, `got ${noKey.status}`);
  check("no key is -32001", noKey.body.error?.code === -32001);

  const deadKey = await callTool("psh_agent_not_a_real_key", { message: "should not work" });
  check("a bad key is 401", deadKey.status === 401 && deadKey.body.error?.code === -32001);

  const wrongTool = await rpc(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } },
    { key },
  );
  check("an unknown tool is -32602", wrongTool.body.error?.code === -32602);

  const noMessage = await callTool(key, { title: "no message" });
  check("a missing message is -32602", noMessage.body.error?.code === -32602);

  const badTimeout = await callTool(key, { message: "x", timeoutSec: 0 });
  check("timeoutSec 0 is -32602", badTimeout.body.error?.code === -32602);

  console.log("\ndecisions");
  const approveTitle = `mcp approve ${Date.now()}`;
  const approveCall = callTool(key, { title: approveTitle, message: "Approve this test action" }, 100);
  const approvedDecision = await answerByTitle(key, approveTitle, true);
  check("the prompt reached the human", approvedDecision);
  const approveReply = await approveCall;
  const approvePayload = toolPayload(approveReply.body);
  check("approve returns approved true", approvePayload.approved === true, JSON.stringify(approvePayload));
  check("approve returns status approved", approvePayload.status === "approved");
  check("approve carries a promptId", typeof approvePayload.promptId === "string");

  const denyTitle = `mcp deny ${Date.now()}`;
  const denyCall = callTool(key, { title: denyTitle, message: "Deny this test action" }, 101);
  await answerByTitle(key, denyTitle, false);
  const denyReply = await denyCall;
  const denyPayload = toolPayload(denyReply.body);
  check("deny returns approved false", denyPayload.approved === false, JSON.stringify(denyPayload));
  check("deny returns status denied", denyPayload.status === "denied");

  const answerTitle = `mcp answer ${Date.now()}`;
  const answerCall = callTool(key, { title: answerTitle, message: "Answer this instead" }, 102);
  const answerDeadline = Date.now() + 8000;
  let answered = false;
  while (Date.now() < answerDeadline && !answered) {
    const found = (await pendingPrompts(key)).find((p) => p.title === answerTitle);
    if (found) {
      await decide(key, found.id, false, "do it the other way");
      answered = true;
    } else {
      await Bun.sleep(120);
    }
  }
  const answerPayload = toolPayload((await answerCall).body);
  check("an answered prompt reports status answered", answerPayload.status === "answered", JSON.stringify(answerPayload));
  check("the human's words come back as answer", answerPayload.answer === "do it the other way");
  check("an answer is not an approval", answerPayload.approved === false);

  const slowTitle = `mcp timeout ${Date.now()}`;
  const slowStart = Date.now();
  const slow = await callTool(key, { title: slowTitle, message: "Nobody will answer", timeoutSec: 1 }, 103);
  const slowPayload = toolPayload(slow.body);
  check("a timeout returns approved false", slowPayload.approved === false, JSON.stringify(slowPayload));
  check("a timeout is reported as expired", slowPayload.status === "expired", String(slowPayload.status));
  check("the timeout is honoured", Date.now() - slowStart < 6000, `${Date.now() - slowStart}ms`);

  console.log("\nparity with the HTTP route");
  const oracleTitle = `mcp parity ${Date.now()}`;
  const oracleHook = fetch(`${BASE}/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-psh-key": key },
    body: JSON.stringify({ title: oracleTitle, message: "Same question, HTTP route", timeoutMs: 10000 }),
  });
  await answerByTitle(key, oracleTitle, true);
  const oracleJson = (await (await oracleHook).json()) as { approved?: boolean; status?: string };
  check("POST / still approves", oracleJson.approved === true, JSON.stringify(oracleJson));
  check("POST / reports the same status vocabulary", oracleJson.status === "approved");

  console.log("\nconcurrency");
  const parallelKey = await mintKey();
  const jobs = [1, 2, 3, 4, 5].map(async (n) => {
    const title = `mcp parallel ${n} ${Date.now()}`;
    const want = n % 2 === 1;
    const call = callTool(parallelKey, { title, message: `Parallel ask ${n}` }, 200 + n);
    await answerByTitle(parallelKey, title, want);
    return { want, payload: toolPayload((await call).body) };
  });
  const results = await Promise.all(jobs);
  check(
    "five parallel asks each get their own decision",
    results.every((r) => r.payload.approved === r.want),
    JSON.stringify(results.map((r) => [r.want, r.payload.approved, r.payload.status, r.payload.limitReached])),
  );
  check(
    "parallel asks do not share a promptId",
    new Set(results.map((r) => r.payload.promptId)).size === 5,
  );

  console.log("\nthe allowance");
  // A decision costs two requests, and the mint spent one, so nine unanswered asks
  // exhaust the anonymous allowance exactly. They block for one second each and
  // expire; the tenth ask has nobody to ask and must say so instead of blocking.
  const limitKey = await mintKey();
  const burn = Array.from({ length: 9 }, (_, i) =>
    callTool(limitKey, { title: `mcp burn ${i} ${Date.now()}`, message: `Burn ${i}`, timeoutSec: 1 }, 300 + i),
  );
  const burned = await Promise.all(burn);
  check(
    "unanswered asks expire and approve nothing",
    burned.every((r) => toolPayload(r.body).approved === false),
    JSON.stringify(burned.map((r) => toolPayload(r.body))),
  );

  const overStart = Date.now();
  const over = await callTool(limitKey, { title: "mcp over limit", message: "Should be refused" }, 400);
  const overPayload = toolPayload(over.body);
  check("an over-limit ask does not block", Date.now() - overStart < 4000, `${Date.now() - overStart}ms`);
  check("an over-limit ask returns approved false", overPayload.approved === false);
  check("an over-limit ask says so", overPayload.limitReached === true, JSON.stringify(overPayload));
  check("an over-limit ask is an error, not a silent denial", over.body.result?.isError === true);

  console.log("\ndiscovery");
  const descriptor = (await (await fetch(`${BASE}/.well-known/mcp.json`)).json()) as {
    transport?: { url?: string };
    tools?: Array<{ name?: string }>;
  };
  check("the descriptor points at /mcp", descriptor.transport?.url === `${BASE}/mcp`, String(descriptor.transport?.url));
  check("the descriptor lists psh_ask", descriptor.tools?.[0]?.name === "psh_ask");
} finally {
  if (server) {
    server.kill();
    await Bun.sleep(300);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
