// psh.now homepage interactions

const AGENTS = [
  "openclaw",
  "claudecode",
  "codex",
  "cursor",
  "hermes",
  "cline",
  "grokbot",
  "perplexity",
  "opencode",
  "antigravity",
  "gemini",
  "githubcopilot",
  "pi",
  "muse",
  "instinct",
];

/** The vendored mark for an agent, resolved like the page's other assets. */
/**
 * The site is served at `/` while its assets live under `/website/`, so a relative
 * `./agenticons/...` resolved against the page and asked for `/agenticons/...`, which is a 404:
 * an empty logo row and a blank mark in the copy button. Resolve against this script instead,
 * which is served from where the assets actually are.
 */
const ASSET_BASE = (() => {
  const el = document.currentScript || document.querySelector('script[src*="app.js"]');
  try {
    return el ? new URL("./", el.src).href : "/website/";
  } catch (_) {
    return "/website/";
  }
})();
const agentIcon = (name) => `${ASSET_BASE}agenticons/agenticon-${name}.svg`;

// ---------- Hero copy button: one agent mark at a time ----------
const pillLogo = document.getElementById("pillAgentLogo");
if (pillLogo) {
  let i = 0;
  pillLogo.src = agentIcon(AGENTS[i]);
  // A stated preference for less motion gets one mark, held rather than cycled.
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    setInterval(() => {
      i = (i + 1) % AGENTS.length;
      // Flash: fade the mark out, swap the file under cover, fade it back in, so
      // the change reads as a deliberate swap rather than a broken image.
      pillLogo.style.opacity = "0";
      setTimeout(() => {
        pillLogo.src = agentIcon(AGENTS[i]);
        pillLogo.style.opacity = "1";
      }, 200);
    }, 2200);
  }
}

// ---------- The shot's agent: mark, colour and name on a rotation ----------
/*
 * Mirrors the dashboard's own agent chips in public/app.js. Kept as its own copy
 * because the two are served from different roots with no build step between
 * them, so there is nothing to share.
 */
const SHOT_AGENTS = [
  ["openclaw", "openclaw", "#4f46e5"],
  ["claudecode", "claude-code", "#e11d48"],
  ["codex", "codex", "#059669"],
  ["cursor", "cursor", "#2563eb"],
  ["hermes", "hermes", "#7c3aed"],
  ["cline", "cline", "#0891b2"],
  ["grokbot", "grok", "#475569"],
  ["perplexity", "perplexity", "#0d9488"],
  ["opencode", "opencode", "#9333ea"],
  ["antigravity", "antigravity", "#c026d3"],
  ["gemini", "gemini-cli", "#0284c7"],
  ["githubcopilot", "github copilot", "#65a30d"],
  ["pi", "pi", "#16a34a"],
  ["muse", "muse", "#db2777"],
  ["instinct", "instinct", "#dc2626"],
];

const shotChip = document.getElementById("shotChip");
const shotChipLogo = document.getElementById("shotChipLogo");
const shotName = document.getElementById("shotName");
if (shotChip && shotChipLogo && shotName) {
  const group = shotChip.closest(".shot-agent");
  let i = 0;
  const paint = ([slug, label, bg]) => {
    shotChip.style.background = bg;
    shotChipLogo.src = agentIcon(slug);
    shotName.textContent = label;
  };
  paint(SHOT_AGENTS[i]);
  if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    setInterval(() => {
      i = (i + 1) % SHOT_AGENTS.length;
      // Fade the whole identity out, repaint it under cover, fade it back.
      group.style.opacity = "0";
      setTimeout(() => {
        paint(SHOT_AGENTS[i]);
        group.style.opacity = "1";
      }, 220);
    }, 2400);
  }
}

// ---------- Agent row (static) ----------
const track = document.getElementById("agentsRow");
if (track) {
  const makeItem = (name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "agent-item";
    b.setAttribute("aria-label", `Copy setup prompt for ${name}`);
    b.innerHTML = `<img class="invert-on-dark" src="${agentIcon(name)}" alt="" loading="lazy" />`;
    b.addEventListener("click", () => copyPrompt(b));
    return b;
  };
  // One pass: the row is static now, so the list is no longer duplicated.
  for (const name of AGENTS) track.appendChild(makeItem(name));
}

// ---------- Copy prompt for agent ----------
// The online link, always: this is what a person pastes into a new agent chat, so
// it points at the running service.
//
// Canonical #1 (fresh install): one string, one copyable block, no environment
// variables, and the install and the setup merged into a single command so the
// agent's harness only needs one approval. docs/prompt-templates.md is the single
// source of truth; this page used to be its own third variant, and it is the
// most-clicked copy button in the product.
const PROMPT =
  "I'd like you to set up psh.now: Install as a skill with npx skills add passy-ai/psh-now-skill -g -y\n" +
  "\n" +
  "If not, do this instead: curl -fsSL https://psh.now/install.sh -o /tmp/psh-install.sh && bash /tmp/psh-install.sh\n" +
  "\n" +
  "After installing, send me a test request.";

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

function copyPrompt(btn) {
  void writeClipboard(PROMPT).then((ok) => {
    if (!ok) return;
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1800);
  });
}

for (const btn of document.querySelectorAll(".copy-prompt")) {
  btn.addEventListener("click", () => copyPrompt(btn));
}

// ---------- Full-prompt disclosure ----------
const promptToggle = document.getElementById("promptToggle");
const promptPanel = document.getElementById("promptPanel");
const promptCode = document.getElementById("promptCode");
if (promptCode) promptCode.textContent = PROMPT;
if (promptToggle && promptPanel) {
  promptToggle.addEventListener("click", () => {
    const open = promptToggle.getAttribute("aria-expanded") === "true";
    promptToggle.setAttribute("aria-expanded", String(!open));
    if (open) {
      /*
       * Hiding on purpose is immediate. The panel's two-second delay exists to
       * stop the hover preview flickering; applying it to a deliberate tap just
       * reads as a broken button. Cleared on a timer so it can never stick.
       */
      promptPanel.style.transitionDelay = "0s";
      window.setTimeout(() => {
        promptPanel.style.transitionDelay = "";
      }, 400);
    }
    promptPanel.classList.toggle("open", !open);
  });
}

// ---------- Feature tabs ----------
const featureTabs = document.querySelectorAll(".feature-tab");
const featureDetail = document.querySelector(".feature-detail");

const fRow = (label, active) =>
  `<div class="panel-row${active ? " active" : ""}"><span class="radio"></span><span class="label">${label}</span></div>`;
const fCard = (title, inner) =>
  `<div class="browser-card"><div class="panel-title">${title}</div><div class="panel-list">${inner}</div></div>`;

const FEATURES = {
  "One hub": {
    title: "Every agent, one place",
    body: `Local terminals, remote boxes, and sandboxes that outlive your session all ask in the same hub. You see what needs you at a glance instead of hunting through tabs and swapping terminals.`,
    cards: [
      fCard(
        "Waiting on you",
        fRow("ci-runner-3 · needs input", true) +
          fRow("support-bot · clarify") +
          fRow("release-agent · approve"),
      ),
      fCard(
        "Cleared today",
        fRow("12 approved", true) + fRow("3 denied") + fRow("5 clarified"),
      ),
    ],
    chips: [
      "“Ask me <b>here</b>, not in the terminal”",
      "“Route <b>every agent</b> through psh.now”",
      "“Keep <b>one inbox</b> for decisions”",
    ],
    learn: "Learn more about the hub →",
  },
  "Any device": {
    title: "Phone, tablet, desktop",
    body: `Pair each device with a simple link and answer from whichever is closest. It's an installable PWA, so requests arrive as live alerts, even when the app isn't open.`,
    cards: [
      fCard(
        "Paired devices",
        fRow("iPhone 15 Pro (this device)", true) +
          fRow("iPad (paired)") +
          fRow("MacBook Pro (paired)"),
      ),
      fCard(
        "Delivery",
        fRow("Live alert over WebSocket", true) +
          fRow("Push when backgrounded") +
          fRow("Syncs across every device"),
      ),
    ],
    chips: [
      "“Pair my <b>tablet</b>”",
      "“Send alerts to my <b>desktop</b>”",
      "“Add my <b>work phone</b>”",
    ],
    learn: "Learn more about devices →",
  },
  Team: {
    title: "Your team can answer too",
    body: `Share a channel with a teammate and they can reply in your place. Whoever is free first clears the queue, so no one has to babysit one specific machine.`,
    cards: [
      fCard(
        "Members",
        fRow("you@acme.com (admin)", true) +
          fRow("sam@acme.com (approver)") +
          fRow("dana@acme.com (approver)"),
      ),
      fCard(
        "This week",
        fRow("You (24 decisions)", true) + fRow("Sam (11)") + fRow("Dana (6)"),
      ),
    ],
    chips: [
      "“Invite <b>sam@acme.com</b> as an approver”",
      "“Let the team answer this channel”",
      "“Only <b>@acme.com</b> can approve”",
    ],
    learn: "Learn more about team approvals →",
  },
  Clarify: {
    title: "Not just yes or no",
    body: `When a plain approve/deny isn't enough, the agent asks an open question: which region, which branch, which of three options. Your answer travels back in the response as free text, so the agent carries on with your actual intent instead of guessing.`,
    cards: [
      fCard(
        "Needs a decision",
        fRow("Which region should this deploy to?", true) +
          fRow("Pick a name for the branch") +
          fRow("Escalate to a human?"),
      ),
      fCard(
        "Your reply",
        `<pre class="panel-code">↳ ship to eu-west-1 first,
  then mirror to us-east</pre>`,
      ),
    ],
    chips: [
      "“Ask me when the spec is <b>ambiguous</b>”",
      "“I'll <b>answer in words</b>, not just yes”",
      "“Escalate if I'm <b>away</b>”",
    ],
    learn: "Learn more about clarify →",
  },
  "Agent-to-agent": {
    title: "Agents can approve each other",
    body: `Run a central agent that watches the channels you trust and answers on your behalf, reviewing, approving, or routing work so the fleet keeps moving without you.`,
    cards: [
      fCard(
        "Reviewer agent",
        fRow("Watches #deploy (active)", true) +
          fRow("Watches #data") +
          fRow("Escalates to you when unsure"),
      ),
      fCard(
        "Scoped keys",
        fRow("Can approve in #deploy", true) +
          fRow("Can read #data") +
          fRow("Cannot touch other channels"),
      ),
    ],
    chips: [
      "“Watch this channel and approve safe work”",
      "“Escalate to me when <b>unsure</b>”",
      "“Never auto-approve <b>#prod</b>”",
    ],
    learn: "Learn more about agent-to-agent →",
  },
  Channels: {
    title: "One scoped key per channel",
    body: `Give each agent its own channel: an <b>ask-only</b> key bound to one place. Requests land where they belong, and an agent on marketing can never touch the deploy key.`,
    cards: [
      fCard(
        "Channels",
        fRow("#deploy (ask-only)", true) +
          fRow("#support (ask-only)") +
          fRow("#data (ask-only)"),
      ),
      fCard(
        "Scoped key",
        fRow("Can request decisions", true) +
          fRow("Can read its own channel") +
          fRow("Can never approve or manage"),
      ),
    ],
    chips: [
      "“Create a <b>deploy channel</b> for you”",
      "“Share the <b>support channel</b> with the team”",
      "“Keep the data channel <b>read-only</b>”",
    ],
    learn: "Learn more about channels →",
  },
};

function renderFeature(name) {
  const f = FEATURES[name];
  if (!f || !featureDetail) return;
  featureDetail.innerHTML = `
    <h3>${f.title}</h3>
    <p>${f.body}</p>
    <div class="showcase"><div class="showcase-grid">${f.cards.join("")}</div></div>
    <p class="tell-label">TELL YOUR AGENT</p>
    <div class="chips">${f.chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>
    <a class="learn" href="./docs.html">${f.learn}</a>`;
}

for (const tab of featureTabs) {
  tab.addEventListener("click", () => {
    for (const t of featureTabs) t.classList.toggle("active", t === tab);
    renderFeature(tab.textContent.trim());
  });
}

// ---------- Header copy pill appears after scrolling past the hero CTA ----------
const headerCopy = document.getElementById("headerCopy");
const heroCta = document.querySelector(".hero-cta");
if (headerCopy && heroCta && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    ([entry]) => headerCopy.classList.toggle("show", !entry.isIntersecting),
    { rootMargin: "-72px 0px 0px 0px", threshold: 0 },
  );
  io.observe(heroCta);
} else if (headerCopy) {
  headerCopy.classList.add("show");
}

// ---------- Nav star count ----------
// Asked of the public API and never assumed: while the repo is private this 404s and the
// badge stays hidden, rather than advertising a number nobody can check.
const starPill = document.getElementById("starPill");
if (starPill) {
  fetch(`https://api.github.com/repos/passy-ai/psh-now`, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((repo) => {
      const n = Number(repo.stargazers_count) || 0;
      // Zero is not social proof, so the badge waits until there is something to show.
      if (n < 1) return;
      const slot = starPill.querySelector("[data-stars]");
      if (slot) slot.textContent = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
      starPill.hidden = false;
    })
    .catch(() => {});
}

// ---------- Reveal on scroll ----------
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const ro = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          obs.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
  );
  for (const el of reveals) ro.observe(el);
  // Anything already in view on first paint should animate immediately.
  requestAnimationFrame(() => {
    for (const el of reveals) {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) el.classList.add("in");
    }
  });
} else {
  for (const el of reveals) el.classList.add("in");
}

// ---------- Walk away: draw the rails when they are seen ----------
(function () {
  const grid = document.querySelector(".tl-grid");
  if (!grid) return;
  if (!("IntersectionObserver" in window)) {
    grid.classList.add("drawn");
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          grid.classList.add("drawn");
          observer.disconnect();
        }
      }
    },
    { threshold: 0.25 },
  );
  observer.observe(grid);
})();

// ---------- Reviews ----------
/*
 * Real quotes only. Each entry is who said it and what changed once their agent could reach
 * them; anything less specific than that reads as marketing and is worth leaving out.
 *
 * Example shape:
 *   { quote: "I approved a deploy from the train and the run finished before I got off.",
 *     name: "Sam Okonkwo", role: "Platform lead", company: "Northwind" }
 *
 * Empty means the section stays hidden, which is the correct state for a page with no reviews
 * yet.
 */
const REVIEWS = [];

(function () {
  const grid = document.getElementById("reviewGrid");
  const section = document.getElementById("reviews");
  if (!grid || !section || !REVIEWS.length) return;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  grid.innerHTML = REVIEWS.map(function (r) {
    const who = [r.role, r.company].filter(Boolean).join(" at ");
    return '<figure class="review"><blockquote class="review-quote">\u201c' + esc(r.quote) +
      '\u201d</blockquote><figcaption class="review-who">' + esc(r.name || "") +
      (who ? ", " + esc(who) : "") + "</figcaption></figure>";
  }).join("");
  section.hidden = false;
})();
