/**
 * End-to-end test: boots the gateway on an ephemeral port, pairs a fake phone
 * over WebSocket, and verifies that agent hook requests block until the phone
 * approves or denies them.
 *
 *   bun tests/e2e.ts
 *
 * Requires a reachable Postgres from DATABASE_URL (migrations must be applied).
 */

import { spawn } from "bun";

const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;

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

async function waitForHealth(timeoutMs = 15000) {
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

interface Frame {
  type: string;
  [key: string]: unknown;
}

/** A minimal phone: connects, answers every prompt with `answer`. */
function makePhone(deviceToken: string, answer: (frame: Frame) => boolean) {
  const ws = new WebSocket(`${WS_BASE}/ws?token=${deviceToken}`);
  const seen: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  let hello: Frame | null = null;

  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    seen.push(frame);
    for (const waiter of [...waiters]) waiter(frame);
    if (frame.type === "prompt.created") {
      const prompt = frame.prompt as { id: string };
      ws.send(
        JSON.stringify({ type: "decision", promptId: prompt.id, approved: answer(frame) }),
      );
    }
  });

  return {
    ws,
    seen,
    get hello() {
      return hello;
    },
    async ready() {
      if (hello) return hello;
      await new Promise<void>((resolve) => {
        waiters.push((frame) => {
          if (frame.type === "hello") {
            hello = frame;
            resolve();
          }
        });
      });
      return hello;
    },
    close() {
      ws.close();
    },
  };
}

async function main() {
  console.log(`\n\x1b[1mpsh.now e2e\x1b[0m  (gateway on ${BASE})\n`);

  const server = spawn({
    cmd: ["bun", "src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: BASE,
      DEFAULT_TIMEOUT_MS: "8000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitForHealth();

    // 1. Create workspace
    const channelRes = await fetch(`${BASE}/api/v1/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e workspace" }),
    });
    const channel = (await channelRes.json()) as any;
    check("channel created", channelRes.ok && !!channel.apiKey);
    check("api key format", /^psh_live_[A-Za-z0-9]{24}$/.test(channel.apiKey ?? ""));
    check(
      "short workspace id (<= 32)",
      typeof channel.workspace?.id === "string" && channel.workspace.id.length <= 32,
      `got ${channel.workspace?.id}`,
    );

    const apiKey = channel.apiKey as string;

    // 1b. Agent-first provisioning: workspace + pairing in one call.
    const provRes = await fetch(`${BASE}/api/v1/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agent provisioned", pair: true }),
    });
    const prov = (await provRes.json()) as any;
    check(
      "agent can provision + pair in one call",
      provRes.ok && !!prov.pairing?.url && !!prov.pairing?.qrUrl,
      JSON.stringify(prov.pairing),
    );

    // 1c. Anonymous → claim (makes the workspace permanent).
    const wsClaimRes = await fetch(`${BASE}/api/v1/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": apiKey },
      body: JSON.stringify({ email: "e2e@example.com" }),
    });
    const wsClaim = (await wsClaimRes.json()) as any;
    check("claim code issued", wsClaimRes.ok && typeof wsClaim.code === "string");
    const verifyRes = await fetch(`${BASE}/api/v1/claims/${wsClaim.claimId}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: wsClaim.code }),
    });
    const verify = (await verifyRes.json()) as any;
    check("claim verifies", verifyRes.ok && verify.claimed === true, JSON.stringify(verify));
    const meClaimedRes = await fetch(`${BASE}/api/v1/me`, {
      headers: { "x-psh-key": apiKey },
    });
    const meClaimed = (await meClaimedRes.json()) as any;
    check(
      "workspace now permanent",
      meClaimed.workspace?.claimed === true && meClaimed.workspace?.expiresAt === null,
      JSON.stringify(meClaimed.workspace),
    );

    // 2. Mint pairing token
    const pairRes = await fetch(`${BASE}/api/v1/pairing`, {
      method: "POST",
      headers: { "x-psh-key": apiKey },
    });
    const pairing = (await pairRes.json()) as any;
    check("pairing created", pairRes.ok && !!pairing.url);
    check("pairing url is short", (pairing.url as string).length < 80, pairing.url);

    // 3. Claim pairing -> device token
    const claimRes = await fetch(`${BASE}/api/v1/pairing/${pairing.token}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e phone" }),
    });
    const claim = (await claimRes.json()) as any;
    check("device paired", claimRes.ok && !!claim.deviceToken);

    // 4. Connect the phone and approve
    const phone = makePhone(claim.deviceToken, () => true);
    const hello = await phone.ready();
    check("ws hello received", hello?.type === "hello");

    // Connections list: the paired device shows as online while connected.
    const devListRes = await fetch(`${BASE}/api/v1/devices`, {
      headers: { "x-psh-key": apiKey },
    });
    const devList = (await devListRes.json()) as any;
    check(
      "device online status exposed",
      devListRes.ok && devList.devices?.[0]?.online === true,
      JSON.stringify(devList.devices),
    );

    // 5. Agent asks for approval -> should resolve approved
    const approvePromise = fetch(`${BASE}/api/v1/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": apiKey },
      body: JSON.stringify({
        title: "Reinstall dependencies",
        message: "rm -rf node_modules && npm install --force",
        cwd: "/tmp/ecommerce-api",
      }),
    });
    const approveRes = await approvePromise;
    const approve = (await approveRes.json()) as any;
    check("hook approved", approve.approved === true, JSON.stringify(approve));
    check("title preserved", approve.title === "Reinstall dependencies", approve.title);
    check(
      "message preserved",
      String(approve.message).includes("rm -rf"),
      approve.message,
    );
    check("risk flagged critical", approve.risk === "critical", approve.risk);
    check(
      "risk reasons present",
      Array.isArray(approve.riskReasons) && approve.riskReasons.length > 0,
    );
    check(
      "connection id returned",
      typeof approve.connectionId === "string" && approve.connectionId.length > 0,
      approve.connectionId,
    );
    const connRes = await fetch(`${BASE}/api/v1/connections`, {
      headers: { "x-psh-key": apiKey },
    });
    const conn = (await connRes.json()) as any;
    const mine = (conn.connections || []).find((c: any) => c.id === approve.connectionId);
    check("connection is listed", connRes.ok && !!mine, JSON.stringify(conn.connections));
    check(
      "connection is named after the project",
      mine?.name === "ecommerce-api",
      mine?.name,
    );
    const connDetailRes = await fetch(`${BASE}/api/v1/connections/${approve.connectionId}`, {
      headers: { "x-psh-key": apiKey },
    });
    const connDetail = (await connDetailRes.json()) as any;
    check(
      "connection detail includes its request",
      connDetailRes.ok &&
        (connDetail.prompts || []).some((p: any) => p.id === approve.promptId),
    );

    // 5b. Async mode: return a session immediately, then poll for the answer.
    const asyncRes = await fetch(`${BASE}/api/v1/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": apiKey },
      body: JSON.stringify({
        title: "Async deploy",
        message: "Deploy the new build to production?",
        wait: false,
      }),
    });
    const asyncBody = (await asyncRes.json()) as any;
    check(
      "async returns pending + pollUrl",
      asyncBody.status === "pending" && typeof asyncBody.pollUrl === "string",
      JSON.stringify(asyncBody),
    );
    const pollRes = await fetch(`${asyncBody.pollUrl}?wait=5`, {
      headers: { "x-psh-key": apiKey },
    });
    const poll = (await pollRes.json()) as any;
    check(
      "poll resolves to approved",
      pollRes.ok && poll.approved === true && poll.status === "approved",
      JSON.stringify(poll),
    );

    // Legacy `command` field still works and derives a title.
    const legacyRes = await fetch(`${BASE}/api/v1/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": apiKey },
      body: JSON.stringify({ command: "npm run deploy" }),
    });
    const legacy = (await legacyRes.json()) as any;
    check("legacy command accepted", legacy.approved === true, JSON.stringify(legacy));
    check("title derived from command", legacy.title === "npm run deploy", legacy.title);

    // 6. Deny path (close the approving phone first to avoid races)
    phone.close();
    await Bun.sleep(150);
    const denyPhone = makePhone(claim.deviceToken, () => false);
    await denyPhone.ready();
    const denyRes = await fetch(`${BASE}/api/v1/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": apiKey },
      body: JSON.stringify({ message: "echo hello", timeoutMs: 8000 }),
    });
    const deny = (await denyRes.json()) as any;
    check("hook denied", deny.approved === false, JSON.stringify(deny));
    check("status denied", deny.status === "denied", deny.status);

    // 7. Timeout path (no phone answers)
    denyPhone.close();
    await Bun.sleep(100);
    const timeoutRes = await fetch(`${BASE}/api/v1/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": apiKey },
      body: JSON.stringify({ message: "echo timeout", timeoutMs: 1500 }),
    });
    const timeout = (await timeoutRes.json()) as any;
    check("timeout auto-denies", timeout.approved === false, JSON.stringify(timeout));
    check("status expired", timeout.status === "expired", timeout.status);

    // 8. Invalid api key rejected
    const badRes = await fetch(`${BASE}/api/v1/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-key": "psh_live_invalid" },
      body: JSON.stringify({ message: "ls" }),
    });
    check("invalid api key -> 401", badRes.status === 401, `got ${badRes.status}`);

    // 9. Pairing token is single-use
    const reuseRes = await fetch(`${BASE}/api/v1/pairing/${pairing.token}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "reuse" }),
    });
    check("pairing token single-use", reuseRes.status === 410, `got ${reuseRes.status}`);

    // 10. PWA shell served
    const appRes = await fetch(`${BASE}/app`);
    check("PWA shell served", appRes.ok);
    const setupRes = await fetch(`${BASE}/setup`);
    const setupHtml = await setupRes.text();
    check("setup UI served", setupRes.ok && setupHtml.includes("Create a link"));
    const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
    check("manifest served", manifestRes.ok);

    // 11. Pairing QR endpoint renders SVG
    const qrRes = await fetch(`${BASE}/api/v1/qr?data=${encodeURIComponent(pairing.url)}`);
    check(
      "QR endpoint returns SVG",
      qrRes.ok && (qrRes.headers.get("content-type") || "").includes("image/svg+xml"),
    );

    // 12. A paired device may mint another pairing code (for the UI invite flow)
    const devicePairRes = await fetch(`${BASE}/api/v1/pairing`, {
      method: "POST",
      headers: { "x-psh-device": claim.deviceToken },
    });
    const devicePair = (await devicePairRes.json()) as any;
    check("device can mint pairing code", devicePairRes.ok && !!devicePair.qrUrl);

    // 13. A device can send itself a non-blocking test approval
    const testRes = await fetch(`${BASE}/api/v1/test`, {
      method: "POST",
      headers: { "x-psh-device": claim.deviceToken },
    });
    const testPrompt = (await testRes.json()) as any;
    check(
      "test approval created",
      testRes.ok && testPrompt.prompt?.kind === "test",
      JSON.stringify(testPrompt),
    );

    // 14. A paired device can mint a fresh agent key, and it authenticates.
    const keyRes = await fetch(`${BASE}/api/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-psh-device": claim.deviceToken },
      body: JSON.stringify({ name: "e2e recovered key" }),
    });
    const newKey = (await keyRes.json()) as any;
    check(
      "device can mint an agent key",
      keyRes.ok && /^psh_live_[A-Za-z0-9]{24}$/.test(newKey.key ?? ""),
      JSON.stringify(newKey),
    );
    const newKeyMe = await fetch(`${BASE}/api/v1/me`, {
      headers: { "x-psh-key": newKey.key },
    });
    check("minted agent key authenticates", newKeyMe.ok, `got ${newKeyMe.status}`);
    const revealRes = await fetch(`${BASE}/api/v1/keys/${newKey.id}/reveal`, {
      headers: { "x-psh-device": claim.deviceToken },
    });
    const reveal = (await revealRes.json()) as any;
    check(
      "minted key is revealable to the operator",
      revealRes.ok && reveal.key === newKey.key,
      JSON.stringify(reveal),
    );
    const keyListRes = await fetch(`${BASE}/api/v1/keys`, {
      headers: { "x-psh-device": claim.deviceToken },
    });
    const keyList = (await keyListRes.json()) as any;
    check(
      "key list shows the new key",
      keyListRes.ok && (keyList.keys || []).some((k: any) => k.id === newKey.id),
    );
    // 12. CSV export: a signed link that downloads, and nothing it should not
    const exportRes = await fetch(`${BASE}/api/v1/channels/${approve.connectionId}/export`, {
      method: "POST",
      headers: { "x-psh-device": claim.deviceToken },
    });
    const exported = (await exportRes.json()) as any;
    check("export link minted", exportRes.ok && typeof exported.url === "string", JSON.stringify(exported));
    check("export counts decided rows", exported.count >= 1, `count=${exported.count}`);

    const csvRes = await fetch(`${BASE}${exported.url}`);
    const csv = await csvRes.text();
    check(
      "export arrives as a download",
      (csvRes.headers.get("content-disposition") || "").startsWith("attachment"),
      csvRes.headers.get("content-disposition") || "no header",
    );
    check("export is UTF-8 with a BOM", csv.startsWith("\ufeff"));
    check(
      "export has the header row",
      csv.includes("Requested,Request,Details,Status,Answer,Decision,Agent,Decided by,Decided at"),
    );
    check("export holds the decided request", csv.includes("Reinstall dependencies"));

    const token = exported.url.split("/").pop() as string;
    const forgedRes = await fetch(`${BASE}/api/v1/export/${token.slice(0, -2)}xx`);
    check("edited export link rejected", forgedRes.status === 403, `got ${forgedRes.status}`);

  } finally {
    server.kill();
    await server.exited.catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n\x1b[31mfatal:\x1b[0m", err);
  process.exit(1);
});
