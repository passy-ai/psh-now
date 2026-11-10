/**
 * Builds the per-agent integration pages under `website/agents/`.
 *
 *   bun scripts/build-agent-pages.ts
 *
 * One data table, one template: ten pages that must not drift from each other, plus
 * the hub that links them. The facts on these pages are the ones the product can
 * prove - the install line, the directory the skill lands in, the prompt, `psh
 * status` - so nothing here is a claim about a harness that was not checked. Only
 * Claude Code appears with a hook, because it is the only harness with one wired.
 *
 * Logos are Simple Icons (CC0), fetched once into `website/agents/logos/`.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const HOST = "https://psh.now";
const SKILL = "passy-ai/psh-now-skill";
const UNIVERSAL = "~/.agents/skills/psh-now";

interface Agent {
  slug: string;
  name: string;
  logo: string;
  /** One line under the title: why this harness is worth a page. */
  tagline: string;
  /** Two or three sentences of what a reader is actually getting. */
  what: string;
  /** Where the skill lands for this harness. UNIVERSAL unless it has its own folder. */
  dir: string;
  /** Only where a hook exists and was built: the gate, not the ask. */
  hook?: boolean;
}

const AGENTS: Agent[] = [
  {
    slug: "claude-code",
    name: "Claude Code",
    logo: "claude",
    tagline: "Hooks and skills, so every Bash command can wait for you.",
    what:
      "Claude Code reads skills from ~/.claude/skills, and it is the one harness here that also exposes a " +
      "PreToolUse hook - which turns psh.now from an ask into a gate that cannot be skipped.",
    dir: "~/.claude/skills/psh-now",
    hook: true,
  },
  {
    slug: "codex",
    name: "Codex",
    logo: "openai",
    tagline: "A skill in the shared directory. Nothing to configure.",
    what:
      "Codex reads the universal skills directory, so installing psh.now is the whole integration. " +
      "Any command it runs can then route a question to you instead of stalling.",
    dir: UNIVERSAL,
  },
  {
    slug: "cursor",
    name: "Cursor",
    logo: "cursor",
    tagline: "Ask before the agent touches the repo.",
    what:
      "Cursor reads skills from ~/.cursor/skills. The agent already has a terminal, which is all psh.now " +
      "needs: one call, one blocking wait, one boolean back.",
    dir: "~/.cursor/skills/psh-now",
  },
  {
    slug: "cline",
    name: "Cline",
    logo: "cline",
    tagline: "Approval for every shell step it runs.",
    what:
      "Cline reads the universal skills directory. Anything destructive it is about to run - a delete, a " +
      "force-push, a migration - can become a question that waits for your tap.",
    dir: UNIVERSAL,
  },
  {
    slug: "windsurf",
    name: "Windsurf",
    logo: "windsurf",
    tagline: "The same approval page, from an editor.",
    what:
      "Windsurf reads the universal skills directory. The setup is the standard one; the difference is " +
      "that you answer from your phone while the editor stays where it is.",
    dir: UNIVERSAL,
  },
  {
    slug: "opencode",
    name: "OpenCode",
    logo: "opencode",
    tagline: "Open source agent, open source approval.",
    what:
      "OpenCode reads skills from ~/.config/opencode/skills. Both halves of this pairing are MIT licensed, " +
      "so the whole path from question to answer is code you can read.",
    dir: "~/.config/opencode/skills/psh-now",
  },
  {
    slug: "trae",
    name: "Trae",
    logo: "trae",
    tagline: "One channel, every agent in the editor.",
    what:
      "Trae reads skills from ~/.trae/skills. The channel is shared, so the same page answers Trae and " +
      "whatever else you run next to it.",
    dir: "~/.trae/skills/psh-now",
  },
  {
    slug: "hermes-agent",
    name: "Hermes Agent",
    logo: "hermes",
    tagline: "Long-running work that can still stop to ask.",
    what:
      "Hermes Agent reads skills from ~/.hermes/skills. A run that would otherwise park on a question keeps " +
      "going once you answer - from any device, at any hour.",
    dir: "~/.hermes/skills/psh-now",
  },
  {
    slug: "warp",
    name: "Warp",
    logo: "warp",
    tagline: "The terminal asks, your phone answers.",
    what:
      "Warp reads the universal skills directory, and the agent runs commands in the terminal it already " +
      "owns. One command changes from 'do it' to 'ask first'.",
    dir: UNIVERSAL,
  },
  {
    slug: "qwen-code",
    name: "Qwen Code",
    logo: "qwen",
    tagline: "Approval that works in a sandbox with no browser.",
    what:
      "Qwen Code reads the universal skills directory. A container has no browser and often no attention; " +
      "the question travels out, the answer comes back, the work continues.",
    dir: UNIVERSAL,
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAV = `      <header class="site-header">
        <div class="header-inner">
        <div class="header-left">
          <a class="brand" href="/">
            <img class="invert-on-dark" src="/website/psh-mark.svg" alt="" />
            psh.now
          </a>
          <nav class="header-nav" aria-label="Main">
            <a class="nav-link" href="/docs">Docs</a>
            <a class="nav-link" href="/agents" aria-current="page">Agents</a>
            <a class="nav-link" href="/teams">Teams</a>
            <a class="nav-link" href="/alternatives">Alternatives</a>
            <a class="nav-link" href="https://github.com/passy-ai/psh-now" target="_blank" rel="noopener noreferrer">GitHub</a>
          </nav>
        </div>
        <div class="header-right">
          <a class="nav-link" href="/app">Log in</a>
          <a class="btn btn-primary" href="/app">Get started</a>
        </div>
        </div>
      </header>`;

const FOOTER = `      <footer class="site-footer">
        <div class="footer-inner">
          <div>
            <div class="footer-brand">
              <img class="invert-on-dark" src="/website/psh-mark.svg" alt="" />
              psh.now
            </div>
            <p class="footer-tag">One hub for every agent that needs you</p>
          </div>
          <div class="footer-col">
            <h4>PRODUCT</h4>
            <a href="/docs">Docs</a>
            <a href="/agents">Agents</a>
            <a href="/teams">Teams</a>
            <a href="/alternatives">Alternatives</a>
            <a href="/self-hosting">Self hosting</a>
            <a href="/llms.txt">llms.txt</a>
          </div>
          <div class="footer-col">
            <h4>OPEN SOURCE</h4>
            <a href="https://github.com/passy-ai/psh-now" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://github.com/passy-ai/psh-now/releases" target="_blank" rel="noopener noreferrer">Releases</a>
            <a href="https://github.com/passy-ai/psh-now/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT licence</a>
          </div>
          <div class="footer-col">
            <h4>LEGAL</h4>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
          </div>
          <div class="footer-col">
            <h4>COMPANY</h4>
            <a href="https://absolum.nl">Absolum</a>
            <a href="mailto:hello@psh.now">Contact</a>
          </div>
        </div>
        <div class="footer-bottom">© 2026 psh.now · Open source, MIT licensed</div>
      </footer>`;

function head(agent: Agent): string {
  const title = `${agent.name} + psh.now — ask before it acts, from anywhere`;
  const description = `${agent.name} integration for psh.now: install the skill with one command, then any action the agent is about to take can become a question you answer from your phone. ${agent.tagline}`;
  const crumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "psh.now", item: `${HOST}/` },
      { "@type": "ListItem", position: 2, name: "Agents", item: `${HOST}/agents` },
      { "@type": "ListItem", position: 3, name: agent.name, item: `${HOST}/agents/${agent.slug}` },
    ],
  };
  const howTo = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: `Connect ${agent.name} to psh.now`,
    description,
    totalTime: "PT2M",
    step: [
      {
        "@type": "HowToStep",
        name: "Install the skill",
        text: `Run npx skills add ${SKILL} -g -y, or pipe the installer: curl -fsSL ${HOST}/install.sh | sh.`,
      },
      {
        "@type": "HowToStep",
        name: "Join a channel",
        text: "Paste the connect prompt from the dashboard. The channel link gives the agent an ask-only key.",
      },
      {
        "@type": "HowToStep",
        name: "Verify",
        text: "Run psh status. It prints the host, the key, the plan and whether auth succeeded.",
      },
    ],
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${esc(description)}" />
    <title>${esc(title)}</title>
    <link rel="icon" type="image/svg+xml" href="/website/favicon.svg" />
    <link rel="preload" as="font" type="font/woff2" href="/website/fonts/inter-latin.woff2" crossorigin />
    <link rel="stylesheet" href="/website/styles.css" />
    <script type="application/ld+json">${JSON.stringify(crumbs)}</script>
    <script type="application/ld+json">${JSON.stringify(howTo)}</script>
  </head>
  <body>
    <div class="page">
${NAV}
`;
}

const others = (slug: string): string =>
  AGENTS.filter((a) => a.slug !== slug)
    .map(
      (a) =>
        `        <a class="agent-card" href="/agents/${a.slug}"><span class="logo-tile sm"><img src="/website/agents/logos/${a.logo}.svg" alt="" width="20" height="20" /></span><span><span class="name">${a.name}</span><br /><span class="sub">${esc(a.dir.replace("~/.agents/skills/psh-now", "shared skills dir"))}</span></span></a>`,
    )
    .join("\n");

function page(agent: Agent): string {
  const hook = agent.hook
    ? `
        <h2>Make it a gate, not a request</h2>
        <p>
          A skill is an <strong>ask</strong>: the model can skip it. ${agent.name} also runs hooks, and a
          hook is a <strong>gate</strong>: it cannot be skipped. Register it once in
          <code>.claude/settings.json</code> and every Bash command waits for you.
        </p>
        <pre data-copyable>${esc(`{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "psh hook" }] }
    ]
  }
}`)}</pre>
        <p>
          <code>psh hook</code> reads the hook payload on stdin and answers
          <code>permissionDecision: "allow" | "deny"</code>. Read-only commands can be waved through with
          <code>PSH_SKIP_PATTERN</code>, e.g. <code>'^(ls|cat|git status|rg)\\b'</code>.
        </p>`
    : `
        <h2>Ask or gate</h2>
        <p>
          ${agent.name} runs the skill, and a skill is an <strong>ask</strong>: the model can skip it. If your
          setup exposes hooks, wire <code>psh hook</code> and the same call becomes a gate instead. Claude
          Code is the reference: <a href="/agents/claude-code">see its hook</a>.
        </p>`;

  return `${head(agent)}      <main class="subpage">
        <div class="docs-main">
        <p class="crumbs"><a href="/agents">← All agents</a></p>
        <section class="agent-head">
          <span class="logo-tile"><img src="/website/agents/logos/${agent.logo}.svg" alt="${esc(agent.name)} logo" width="26" height="26" /></span>
          <div>
            <h1>${esc(agent.name)} <span class="plus">+</span> psh.now</h1>
            <p class="agent-tagline">${esc(agent.tagline)}</p>
          </div>
        </section>

        <p class="docs-lede">${esc(agent.what)}</p>

        <h2>Install it</h2>
        <p>Two commands, either one. The first is the packaged skill; the second needs no npm and no git.</p>
        <pre data-copyable>npx skills add ${SKILL} -g -y</pre>
        <pre data-copyable>curl -fsSL ${HOST}/install.sh | sh</pre>
        <p>
          It lands in <code>${agent.dir}</code>${agent.dir === UNIVERSAL ? "" : `, so only ${esc(agent.name)} picks it up from there`}.
          The shared directory is the fallback every harness reads, so the same install works everywhere else too.
        </p>

        <h2>Connect a channel</h2>
        <p>
          Open <a href="/app">the dashboard</a>, copy the prompt from a channel card, and give it to
          ${esc(agent.name)}. The link carries the channel, so nothing new is minted and the key it gets is
          <strong>ask-only</strong> - it can request approvals, never approve.
        </p>
        <pre data-copyable>I'd like you to use psh.now and join ${HOST}/c/&lt;channel&gt;.</pre>

        <h2>What it asks with</h2>
        <p>Once installed, the agent's side of the contract is one command:</p>
        <pre data-copyable>psh ask "Deploy the new build?" "This pushes to production."</pre>
        <p>
          It blocks until you answer, then exits <code>0</code> on approval and non-zero otherwise. A timeout
          or an error means do not act - silence is never consent.
        </p>
${hook}

        <h2>Check it works</h2>
        <pre data-copyable>psh status</pre>
        <p>
          Expect the host, <code>auth ✓</code>, the plan and the request count. <code>psh doctor</code> goes
          further: the skill path, the keys, the workspace and any stale record.
        </p>

        <section class="cta-row">
          <a class="btn btn-primary" href="/app">Get a channel</a>
          <a class="btn btn-secondary" href="/docs">Read the docs</a>
        </section>

        <h2>Other agents</h2>
        <div class="agent-grid">
${others(agent.slug)}
        </div>
        <p class="muted">
          Anything else that can run a shell command can ask too - the skill installer supports 79 agents,
          and the CLI is the same everywhere.
        </p>
        </div>
      </main>

${FOOTER}
    </div>
    <script>
      document.querySelectorAll("pre[data-copyable]").forEach((pre) => {
        pre.classList.add("copyable");
        const b = document.createElement("button");
        b.className = "pre-copy";
        b.textContent = "Copy";
        b.onclick = () => {
          navigator.clipboard.writeText(pre.textContent.replace(/Copy$/, "")).then(
            () => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1400); },
            () => { b.textContent = "Copy failed"; },
          );
        };
        pre.appendChild(b);
      });
    </script>
  </body>
</html>
`;
}

function hub(): string {
  const description =
    "One page per agent: how to install psh.now, where the skill lands, the prompt to paste, and the command it asks with. Claude Code, Codex, Cursor, Cline, Windsurf, OpenCode, Trae, Hermes Agent, Warp, Qwen Code.";
  const crumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "psh.now", item: `${HOST}/` },
      { "@type": "ListItem", position: 2, name: "Agents", item: `${HOST}/agents` },
    ],
  };
  const cards = AGENTS.map(
    (a) => `        <a class="agent-card" href="/agents/${a.slug}">
          <span class="logo-tile"><img src="/website/agents/logos/${a.logo}.svg" alt="${esc(a.name)} logo" width="24" height="24" /></span>
          <span><span class="name">${a.name}</span><br /><span class="sub">${esc(a.tagline)}</span></span>
        </a>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${esc(description)}" />
    <title>Agent integrations — Claude Code, Codex, Cursor, Cline and more | psh.now</title>
    <link rel="icon" type="image/svg+xml" href="/website/favicon.svg" />
    <link rel="preload" as="font" type="font/woff2" href="/website/fonts/inter-latin.woff2" crossorigin />
    <link rel="stylesheet" href="/website/styles.css" />
    <script type="application/ld+json">${JSON.stringify(crumbs)}</script>
  </head>
  <body>
    <div class="page">
${NAV}
      <main class="subpage">
        <div class="docs-main">
        <section class="subhead">
          <span class="tag"><span class="dot"></span>Integrations</span>
          <h1>Every agent you run, one page each</h1>
          <p class="docs-lede">
            The install line, the directory the skill lands in, the prompt to paste and the command it asks
            with - for the harnesses people actually search for. The installer supports 79 agents; these are
            the ones with a page.
          </p>
        </section>

        <div class="agent-grid">
${cards}
        </div>

        <h2>Not listed?</h2>
        <p>
          The skill is a folder of shell scripts, so anything with a terminal can use it. Run the same line
          and check with <code>psh status</code>:
        </p>
        <pre data-copyable>npx skills add ${SKILL} -g -y</pre>

        <h2>What every page has in common</h2>
        <ul>
          <li><strong>One channel</strong> answers every agent, and many people can answer one channel.</li>
          <li><strong>Ask-only keys</strong> for agents: they can request an approval and never grant one.</li>
          <li><strong>Blocks until answered</strong> - no polling loop to write, no webhook to host.</li>
          <li><strong>Open source</strong>, MIT: the same code runs self-hosted, and the hooks are readable.</li>
        </ul>

        <section class="cta-row">
          <a class="btn btn-primary" href="/app">Get a channel</a>
          <a class="btn btn-secondary" href="/docs">Read the docs</a>
        </section>
        </div>
      </main>

${FOOTER}
    </div>
    <script>
      document.querySelectorAll("pre[data-copyable]").forEach((pre) => {
        pre.classList.add("copyable");
        const b = document.createElement("button");
        b.className = "pre-copy";
        b.textContent = "Copy";
        b.onclick = () => {
          navigator.clipboard.writeText(pre.textContent.replace(/Copy$/, "")).then(
            () => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1400); },
            () => { b.textContent = "Copy failed"; },
          );
        };
        pre.appendChild(b);
      });
    </script>
  </body>
</html>
`;
}

// A page that points at a logo that is not there renders a broken image and nothing
// says so, so the build stops instead.
for (const a of AGENTS) {
  const logo = `website/agents/logos/${a.logo}.svg`;
  if (!existsSync(logo)) throw new Error(`missing logo for ${a.slug}: ${logo}`);
}

mkdirSync("website/agents", { recursive: true });
for (const a of AGENTS) {
  writeFileSync(`website/agents/${a.slug}.html`, page(a));
}
writeFileSync("website/agents/index.html", hub());
console.log(`wrote ${AGENTS.length} agent pages + the hub`);
console.log(AGENTS.map((a) => `/agents/${a.slug}`).join(" "));
