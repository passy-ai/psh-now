#!/usr/bin/env bun
/**
 * psh.now CLI
 *
 *   psh init                 Create a workspace, print API key + pairing QR
 *   psh pair                 Mint a fresh pairing link/QR for this workspace
 *   psh ask "<command>"      Block until a human approves/denies the command
 *   psh hook                 Agent hook (reads tool JSON on stdin)
 *   psh status               Show pending requests
 *   psh doctor               Verify connectivity + credentials
 *
 * Works with the psh.now gateway defined in ../src.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import QRCode from "qrcode";

const CONFIG_DIR = join(homedir(), ".psh");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_BASE_URL = process.env.PSH_BASE_URL || "http://localhost:3000";

interface Config {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  workspaceName?: string;
}

/* ------------------------------ tiny helpers ----------------------------- */

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const say = (msg = "") => process.stdout.write(`${msg}\n`);
const ok = (msg: string) => say(`${c.green}${msg}${c.reset}`);
const warn = (msg: string) => say(`${c.yellow}${msg}${c.reset}`);
const fail = (msg: string) => say(`${c.red}${msg}${c.reset}`);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from cwd looking for a project-local `.psh/config.json`. */
async function findLocalConfig(): Promise<string | null> {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".psh", "config.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve configuration with this precedence:
 *   1. PSH_API_KEY environment variable
 *   2. project-local .psh/config.json (nearest ancestor of cwd)
 *   3. ~/.psh/config.json
 *   4. the installed skill's .keys.json (+ .host)
 */
async function readConfig(): Promise<Config> {
  if (process.env.PSH_API_KEY) {
    return {
      baseUrl: process.env.PSH_BASE_URL || DEFAULT_BASE_URL,
      apiKey: process.env.PSH_API_KEY,
      workspaceId: process.env.PSH_WORKSPACE || "env",
    };
  }

  const local = await findLocalConfig();
  // Project config first, then the machine-global one. Keys live per project
  // (`<project>/.psh/keys.json`), so a machine-global config that names some
  // other project's workspace should never win over the one next to the keys.
  for (const path of [local, CONFIG_PATH].filter(Boolean) as string[]) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Config;
    } catch {
      /* try the next source */
    }
  }

  const userKeys = await readUserKeysConfig();
  if (userKeys) return userKeys;

  const skill = await readSkillConfig();
  if (skill) return skill;

  throw new Error(
    "No psh.now config found. Run `psh init`, or install the skill (its setup mints a channel key).",
  );
}

/**
 * Config written by the skill's setup.sh at <project>/.psh/keys.json
 * (+ .psh/host), with the machine-global ~/.psh as fallback. Keeps `psh` usable
 * even when setup.sh did not write a config.json next to the keys.
 */
async function readUserKeysConfig(): Promise<Config | null> {
  // Project keys win: they are the ones the agent in this directory actually
  // asks with. ~/.psh may belong to a completely different install.
  const dirs = [await findLocalKeysDir(), CONFIG_DIR].filter(Boolean) as string[];
  for (const dir of dirs) {
    const config = await readKeysDir(dir);
    if (config) return config;
  }
  return null;
}

/** Nearest ancestor with .psh/keys.json, never climbing into $HOME. */
async function findLocalKeysDir(): Promise<string | null> {
  let dir = process.cwd();
  while (true) {
    if (dir !== homedir() && (await exists(join(dir, ".psh", "keys.json")))) {
      return join(dir, ".psh");
    }
    const parent = dirname(dir);
    if (parent === dir || dir === homedir()) return null;
    dir = parent;
  }
}

async function readKeysDir(dir: string): Promise<Config | null> {
  try {
    const keys = JSON.parse(await readFile(join(dir, "keys.json"), "utf8")) as {
      channelKey?: string;
      apiKey?: string;
      userKey?: string;
      workspaceId?: string;
    };
    const apiKey = keys.channelKey ?? keys.apiKey ?? keys.userKey;
    if (!apiKey) return null;

    let baseUrl = DEFAULT_BASE_URL;
    try {
      baseUrl = (await readFile(join(dir, "host"), "utf8")).trim() || baseUrl;
    } catch {
      /* keep the default */
    }

    return { baseUrl, apiKey, workspaceId: keys.workspaceId ?? "skill" };
  } catch {
    return null;
  }
}

/** Config minted by the skill installer, saved next to the installed skill. */
async function readSkillConfig(): Promise<Config | null> {
  const dir = join(homedir(), ".agents", "skills", "psh-now");
  try {
    const keys = JSON.parse(await readFile(join(dir, ".keys.json"), "utf8")) as {
      channelKey?: string;
      apiKey?: string;
      userKey?: string;
      workspaceId?: string;
    };
    const apiKey = keys.channelKey ?? keys.apiKey ?? keys.userKey;
    if (!apiKey) return null;

    let baseUrl = DEFAULT_BASE_URL;
    try {
      baseUrl = (await readFile(join(dir, ".host"), "utf8")).trim() || baseUrl;
    } catch {
      /* keep the default */
    }

    return { baseUrl, apiKey, workspaceId: keys.workspaceId ?? "skill" };
  } catch {
    return null;
  }
}

/** Write to a project-local `.psh/config.json` when `local` is true. */
async function writeConfig(config: Config, local = false): Promise<string> {
  const path = local ? join(process.cwd(), ".psh", "config.json") : CONFIG_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}

/**
 * Read config, or mint an anonymous workspace on first use and save it
 * project-locally (like here.now's anonymous publish + state file).
 */
async function ensureConfig(): Promise<Config> {
  let config: Config | null = null;
  try {
    config = await readConfig();
  } catch {
    config = null;
  }

  // Verify an existing key; re-mint if it no longer works.
  if (config) {
    try {
      await api("/api/v1/me", { apiKey: config.apiKey, baseUrl: config.baseUrl });
      return config;
    } catch {
      warn("⚠ Existing key is invalid — minting a new anonymous workspace.");
    }
  }

  const minted = await api<{ apiKey: string; workspaceId: string }>("/api/v1/mint", {
    method: "POST",
  });
  const fresh: Config = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: minted.apiKey,
    workspaceId: minted.workspaceId,
    workspaceName: "Anonymous",
  };
  const saved = await writeConfig(fresh, true);
  warn(`✨ Minted an anonymous workspace — key saved to ${saved}`);
  return fresh;
}

async function api<T>(
  path: string,
  init: RequestInit & { apiKey?: string; timeoutMs?: number; baseUrl?: string } = {},
): Promise<T> {
  const { apiKey, timeoutMs, baseUrl, ...rest } = init;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(`${baseUrl ?? DEFAULT_BASE_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-psh-key": apiKey } : {}),
        ...(rest.headers || {}),
      },
    });

    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(json.message || `HTTP ${res.status}`);
    }
    return json as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function printQr(url: string): Promise<void> {
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  say(qr);
  say(`  ${c.cyan}${url}${c.reset}`);
}

/* -------------------------------- commands ------------------------------- */

async function cmdInit(): Promise<void> {
  const name = flagValue("--name") || `${process.cwd().split("/").pop() || "workspace"}`;

  say();
  say(`${c.bold}🔗 Creating your secure psh.now channel...${c.reset}`);

  const created = await api<{
    workspace: { id: string; name: string };
    apiKey: string;
  }>("/api/v1/channels", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  const config: Config = {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: created.apiKey,
    workspaceId: created.workspace.id,
    workspaceName: created.workspace.name,
  };
  const local = process.argv.includes("--local");
  const savedPath = await writeConfig(config, local);

  ok("✨ Channel created successfully!");
  say(`${c.bold}🔑 Your API Key:${c.reset} ${created.apiKey}`);
  say(`${c.dim}   (saved to ${savedPath}, mode 0600)${c.reset}`);
  say();

  const pairing = await api<{ url: string; expiresAt: string }>("/api/v1/devices/pairing", {
    method: "POST",
    apiKey: created.apiKey,
  });

  say(`${c.bold}📱 Scan the QR code to pair your primary supervisor device:${c.reset}`);
  say();
  await printQr(pairing.url);
  say(
    `${c.dim}   Link expires ${new Date(pairing.expiresAt).toLocaleTimeString()}${c.reset}`,
  );
  say();

  // The distribution is the skill, not a rules file (like here.now).
  say(`${c.bold}🧩 Install the skill in your agent:${c.reset}`);
  say(`${c.dim}   npx skills add psh-now/skill --skill psh-now -g${c.reset}`);
  say(`${c.dim}   curl -fsSL ${config.baseUrl}/install.sh | PSH_SKILL_DIR=\"$PWD/.agents/skills/psh-now\" sh${c.reset}`);
  say();
  say(`${c.bold}💬 Or paste this prompt into any agent:${c.reset}`);
  say(`${c.cyan}   Read ${config.baseUrl}/skill.md and follow it. Use it before any${c.reset}`);
  say(`${c.cyan}   destructive action. psh key: ${config.apiKey}${c.reset}`);
  say();
}

async function cmdPair(): Promise<void> {
  const config = await readConfig();
  const pairing = await api<{ url: string; expiresAt: string }>("/api/v1/devices/pairing", {
    method: "POST",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  say();
  say(`${c.bold}📱 Pair another supervisor device${c.reset}`);
  say();
  await printQr(pairing.url);
  say(
    `${c.dim}   Workspace ${config.workspaceId} · expires ${new Date(
      pairing.expiresAt,
    ).toLocaleTimeString()}${c.reset}`,
  );
  say();
}

async function cmdAsk(): Promise<void> {
  const config = await ensureConfig();
  const command = positional().join(" ").trim();
  if (!command) {
    fail("Usage: psh ask \"<command>\"");
    process.exit(2);
  }
  const seconds = Number(flagValue("--timeout"));
  const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  const title = flagValue("--title");
  await requestApproval(config, command, { timeoutMs, title });
}

async function cmdHook(): Promise<void> {
  // Read the agent's tool payload from stdin (Claude Code PreToolUse shape).
  const raw = await new Response(Bun.stdin.stream()).text();
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Not JSON — pass through untouched.
    return;
  }

  const toolName = payload.tool_name || payload.toolName;
  const toolInput = payload.tool_input || payload.toolInput || {};
  const command = toolInput.command || toolInput.cmd;

  // Only intercept shell commands; everything else passes through.
  if (toolName && toolName !== "Bash" && toolName !== "Shell") return;
  if (typeof command !== "string" || command.length === 0) return;

  // Optional allowlist to skip trivial/read-only commands.
  const skipPattern = process.env.PSH_SKIP_PATTERN;
  if (skipPattern && new RegExp(skipPattern).test(command)) return;

  const config = await ensureConfig();
  const result = await requestApproval(config, command, {
    cwd: toolInput.cwd || payload.cwd,
    agent: payload.agent || "claude-code",
    silent: true,
  });

  // Emit the Claude Code PreToolUse decision contract.
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: result.approved ? "allow" : "deny",
      permissionDecisionReason: result.approved
        ? "Approved by supervisor via psh.now"
        : `Denied by supervisor via psh.now${result.reason ? `: ${result.reason}` : ""}`,
    },
  };
  process.stdout.write(JSON.stringify(output));

  if (!result.approved) process.exit(0);
}

interface ApprovalResult {
  approved: boolean;
  reason?: string | null;
  status?: string;
  promptId?: string;
  risk?: string;
  onlineDevices?: number;
}

async function requestApproval(
  config: Config,
  command: string,
  opts: {
    cwd?: string;
    agent?: string;
    silent?: boolean;
    timeoutMs?: number;
    title?: string;
  } = {},
): Promise<ApprovalResult> {
  const started = Date.now();
  // In hook mode stdout is reserved for the JSON decision contract, so all
  // human-readable progress must go to stderr.
  const out = opts.silent ? process.stderr : process.stdout;
  const emit = (msg = "") => out.write(`${msg}\n`);

  if (!opts.silent) {
    emit();
    emit(`${c.bold}⏳ Requesting human authorization...${c.reset}`);
    emit(`${c.dim}   ${command}${c.reset}`);
    emit();
  } else {
    emit(`${c.yellow}⏳ psh.now: awaiting phone approval for:${c.reset} ${command}`);
  }

  const result = await api<ApprovalResult>("/api/v1/approvals", {
    method: "POST",
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    body: JSON.stringify({
      title: opts.title,
      message: command,
      kind: "command",
      cwd: opts.cwd,
      agent: opts.agent,
      timeoutMs: opts.timeoutMs,
      metadata: { pid: process.pid, host: hostnameSafe() },
    }),
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (result.approved) {
    emit(
      `${c.green}✅ Core authorization verified (${elapsed}s). Proceeding with command execution...${c.reset}`,
    );
  } else {
    emit(
      `${c.red}❌ CRITICAL: Operation rejected by remote system administrator (${elapsed}s).${c.reset}`,
    );
    if (result.reason) emit(`${c.dim}   reason: ${result.reason}${c.reset}`);
    if (!opts.silent) {
      emit(
        `${c.dim}   Stopping task execution sequence to preserve environment safety.${c.reset}`,
      );
    }
  }

  if (!opts.silent) emit();
  return result;
}

async function cmdStatus(): Promise<void> {
  const config = await readConfig();
  const data = await api<{ pendingPrompts: number; onlineDevices: number; devices: any[] }>(
    "/api/v1/me",
    { apiKey: config.apiKey, baseUrl: config.baseUrl },
  );
  say();
  say(`${c.bold}Workspace${c.reset}        ${config.workspaceId}`);
  say(`${c.bold}Online devices${c.reset}   ${data.onlineDevices}`);
  say(`${c.bold}Pending prompts${c.reset}  ${data.pendingPrompts}`);
  say(`${c.bold}Paired devices${c.reset}   ${data.devices.length}`);
  for (const d of data.devices) {
    const state = d.revokedAt ? c.red + "revoked" : c.green + "active";
    say(`  - ${d.name} ${c.dim}(${d.id})${c.reset} ${state}${c.reset}`);
  }
  say();
}

async function cmdDoctor(): Promise<void> {
  const config = await readConfig();
  say();
  say(`${c.bold}psh doctor${c.reset}`);
  say(`  base url     ${config.baseUrl}`);
  say(`  workspace    ${config.workspaceId}`);
  say(`  api key      ${config.apiKey.slice(0, 14)}…`);

  const health = await api<{ ok: boolean }>("/api/v1/health", { baseUrl: config.baseUrl });
  say(`  health       ${health.ok ? c.green + "ok" : c.red + "down"}${c.reset}`);
  const me = await api<{ onlineDevices: number }>("/api/v1/me", {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  say(`  auth         ${c.green}ok${c.reset}`);
  say(`  devices      ${me.onlineDevices} online`);
  say();
}

/*
 * Note: psh.now distributes via the *skill* (like here.now), not by writing
 * rules into agents.md / CLAUDE.md / editor configs. The skill is installed
 * into the agent's skills directory and loaded by the agent's own discovery.
 */

/* --------------------------------- parsing ------------------------------- */

function flagValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const prefixed = args.find((a) => a.startsWith(`${flag}=`));
  return prefixed?.slice(flag.length + 1);
}

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  "--name",
  "--timeout",
  "--base",
  "--base-url",
  "--title",
]);

/** Positional arguments after the subcommand, excluding flags and their values. */
function positional(): string[] {
  const args = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

function hostnameSafe(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

/* ---------------------------------- main --------------------------------- */

const command = process.argv[2];

const COMMANDS: Record<string, () => Promise<void>> = {
  init: cmdInit,
  pair: cmdPair,
  ask: cmdAsk,
  hook: cmdHook,
  status: cmdStatus,
  doctor: cmdDoctor,
};

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    say(`
${c.bold}psh.now${c.reset} — approve your agent's commands from your phone.

${c.bold}Usage${c.reset}
  psh init                    Create a workspace + pairing QR
  psh pair                    Mint a new pairing link
  psh ask "<command>"         Block until a human approves/denies
  psh ask --title "…" "<cmd>" With a custom headline
  psh hook                    Agent hook (JSON on stdin)
  psh status                  Show workspace + pending requests
  psh doctor                  Check connectivity + credentials
`);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`Unknown command: ${command}`);
    process.exit(2);
  }

  try {
    await handler();
  } catch (err) {
    fail(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
