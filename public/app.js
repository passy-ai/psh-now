// psh.now supervisor dashboard.
import Pickr from "/vendor/pickr/pickr.min.mjs";

// migrate keys written under the old brand name
for (const k of ["deviceToken", "workspace", "demoApiKey", "notifyAsked"]) {
  const old = localStorage.getItem(`pshy.${k}`);
  if (old && !localStorage.getItem(`psh.${k}`)) localStorage.setItem(`psh.${k}`, old);
}

const K = {
  token: "psh.deviceToken",
  apiKey: "psh.apiKey",
  workspace: "psh.workspace",
  demoKey: "psh.demoApiKey",
  notifyAsked: "psh.notifyAsked",
};

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  statusText: $("statusText"),
  unpaired: $("unpaired"),
  paired: $("paired"),
  openChannels: $("openChannels"),
  closedSection: $("closedSection"),
  closedChannels: $("closedChannels"),
  approvals: $("approvals"),
  toast: $("toast"),
};

const store = {
  get token() {
    return localStorage.getItem(K.token);
  },
  set token(v) {
    v ? localStorage.setItem(K.token, v) : localStorage.removeItem(K.token);
  },
  get apiKey() {
    return localStorage.getItem(K.apiKey);
  },
  set apiKey(v) {
    v ? localStorage.setItem(K.apiKey, v) : localStorage.removeItem(K.apiKey);
  },
  get workspace() {
    try {
      return JSON.parse(localStorage.getItem(K.workspace)) || null;
    } catch {
      return null;
    }
  },
  set workspace(v) {
    localStorage.setItem(K.workspace, JSON.stringify(v));
  },
};

/**
 * The server's public host, learned from `/me`. Prompts and links use this so
 * a copy made on localhost still points a remote agent at the real host.
 */
let publicBaseUrl = null;
function shareHost() {
  return publicBaseUrl || location.origin;
}

const state = {
  ws: null,
  pending: new Map(),
  approvals: [],
  reconnect: 800,
  /** True once the dashboard has faded in; reconnects must not flash it. */
  everReady: false,
  heartbeat: null,
  device: null,
  connections: [],
  channelTabs: {},
  channelOpen: {},
  channelReqOpen: {},
  channelHistOpen: {},
  /** Rendered history by channel, so re-opening and re-rendering cost nothing. */
  hist: {},
  histTimer: {},
  channelConnOpen: {},
  /** Invite links minted in this session, by channel (the server only keeps hashes). */
  inviteLinks: {},
  channelConnect: {},
  /** Device-pairing QR (account-scoped) shared by every channel card header. */
  pairQr: null,
  /** The pairing link itself, kept until it is close to expiring. */
  pairLink: null,
  pairQrUnavailable: false,
  /** Account SECRET key (manage). Memory only - never persisted, never in a URL. */
  secretKey: null,
  welcome: new URLSearchParams(location.search).has("welcome"),
};

/* ------------------------------ helpers -------------------------------- */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `psh_user_abc…xyz4` - prefix + last 4, middle blurred. */
function maskedKey(key) {
  if (!key) return "-";
  const m = /^psh_[a-z]+_/.exec(key);
  const prefix = m ? m[0] : "";
  const rest = key.slice(prefix.length);
  if (rest.length <= 4) return esc(key);
  return `${esc(prefix)}<span class="key-blur">${esc(rest.slice(0, -4))}</span>${esc(rest.slice(-4))}`;
}

/** A pleasant, stable colour per account (hash of the seed → palette). */
function avatarColor(seed) {
  const palette = [
    "#e0662b", "#6c8cff", "#34c759", "#d946ef", "#f43f5e",
    "#14b8a6", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899",
  ];
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/* ------------------------------- icons --------------------------------- */
// Lucide icons (lucide.dev), inlined so there is no runtime dependency.
const ICONS = {
  "thumbs-up": '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>',
  "thumbs-down": '<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  clock:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  // Lucide `share` - the arrow leaving a tray. (This used to hold `share-2`'s
  // three connected dots, which read as a generic node graph, not "share".)
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  share:
    '<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>',
  "more-vertical": '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  // Lucide `message-square` - the Answer button (the human types words back).
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  // Lucide `arrow-up-right` - "this goes somewhere else", used on the guide cards.
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  // Lucide `triangle-alert` - usage warnings.
  // The exclamation is two strokes in one icon: the bar, and a zero-length stroke
  // that renders as the dot. Both are classed so the oversized notice mark can set
  // their weights independently - thinning the triangle should not thin the mark
  // inside it, and the dot must not outgrow the bar above it.
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path class="alert-bar" d="M12 9v4"/><path class="alert-dot" d="M12 17h.01"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
};

function icon(name, size = 16) {
  return `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

const DANGER =
  /(rm\s+-[a-z]*r[a-z]*f[a-z]*|--force\b|\bsudo\b|git\s+push\b[^\n]*(?:--force|\s-f\b)|DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM(?![\s\S]*WHERE)|\bmkfs\b|\bdd\b[^\n]*of=\/dev\/|chmod\s+777|kubectl\s+delete|terraform\s+destroy|\|\s*(?:ba|z|d)?sh\b|shutdown\b|reboot\b)/gi;

const highlight = (text) =>
  esc(text).replace(DANGER, (m) => `<span class="danger">${m}</span>`);

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function status(kind, label) {
  if (!els.status) return;
  els.status.className = `chip ${kind}`;
  els.statusText.textContent = label;
}

function rel(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function api(path, { method = "GET", body, silent = false, signal } = {}) {
  const doFetch = (key) =>
    fetch(path, {
      method,
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(store.token ? { "x-psh-device": store.token } : {}),
        ...(key ? { "x-psh-key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  return (async () => {
    let res = await doFetch(store.apiKey || null);
    // Administering the account needs the secret key. Use the one we hold, and
    // only fall back to asking when there is genuinely nothing to use.
    if (res.status === 403 && !silent) {
      if (!state.secretKey) {
        const entered = window.prompt(
          "Account secret key required for this action:\n(shown once at install; kept in memory only)",
        );
        if (entered) state.secretKey = entered.trim();
      }
      if (state.secretKey) res = await doFetch(state.secretKey);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  })();
}

/**
 * Every account now gets its secret key at creation, so the dashboard can pull
 * it into memory once and never interrupt the owner with a prompt. Silent: a
 * failure here just leaves the prompt as the fallback.
 */
async function loadSecretKey() {
  if (state.secretKey) return state.secretKey;
  try {
    const data = await api("/api/v1/me/secret/reveal", { method: "POST", silent: true });
    if (data?.secretKey) state.secretKey = data.secretKey;
    return state.secretKey;
  } catch {
    return null;
  }
}

/* ------------------------------ sections ------------------------------- */

function wireToggle(btnId, bodyId, onOpen) {
  $(btnId)?.addEventListener("click", () => {
    const body = $(bodyId);
    const opening = body?.classList.contains("hide");
    body?.classList.toggle("hide");
    $(btnId)?.classList.toggle("open");
    if (opening && onOpen) onOpen();
  });
}

wireToggle("closedToggle", "closedChannels");
wireToggle("billingToggle", "billingBody", loadAccount);

$("signOutBtn")?.addEventListener("click", () => {
  store.apiKey = null;
  store.token = null;
  location.reload();
});
$("menuSignout")?.addEventListener("click", () => {
  store.apiKey = null;
  store.token = null;
  location.reload();
});
$("avatarBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  $("avatarMenu")?.classList.toggle("hide");
});
document.addEventListener("click", () => $("avatarMenu")?.classList.add("hide"));

/**
 * Land the user on the place where requests are added: open the account menu and
 * flash the Buy item. `/app#topup` (the link the gateway puts in a limit message)
 * calls this on boot, and so does the note on a request that was recorded while
 * the workspace was out of requests.
 */
function openTopUp() {
  const menu = $("avatarMenu");
  const buy = $("menuPacks") ?? $("menuBuy");
  if (!menu || !buy) return;
  menu.classList.remove("hide");
  buy.classList.remove("flash");
  // Reflow so the animation restarts when it is already flashing.
  void buy.offsetWidth;
  buy.classList.add("flash");
  buy.scrollIntoView({ block: "nearest" });
  setTimeout(() => buy.classList.remove("flash"), 2600);
}

// Fill every `<span data-icon>` with an inline lucide icon.
for (const el of document.querySelectorAll("[data-icon]")) {
  el.innerHTML = icon(el.dataset.icon, 15);
}

// Where to go after signing in: the page that sent us here, when it is this site. `/login` is
// reached from pages that need an account, and landing on the dashboard instead breaks the
// errand the human started.
function afterSignIn() {
  const next = new URLSearchParams(location.search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  // Signing in should not throw away the page someone was on: /app#archived is a
  // place, and a bookmark of it is meant to survive the sign-in form.
  return "/app" + (location.hash === "#archived" ? location.hash : "");
}

/**
 * Leave the sign-in form for the app.
 *
 * Assigning a URL that differs from this one only by its hash is a hash change,
 * not a load, so the page would sit there still showing the form it just closed.
 * When the address is already right, the boot has to be redone in place.
 */
function leaveSignIn() {
  const next = afterSignIn();
  if (next === location.pathname + location.search + location.hash) location.reload();
  else location.href = next;
}

/* ------------------------------- theme --------------------------------- */
function applyTheme(theme) {
  const light = theme === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  try {
    localStorage.setItem("psh.theme", light ? "light" : "dark");
  } catch {
    /* ignore */
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", light ? "#ffffff" : "#0a0a0a");
  const btn = $("menuTheme");
  if (btn) {
    btn.innerHTML = `${icon(light ? "sun" : "moon", 15)} ${light ? "Light mode" : "Dark mode"}`;
  }
}
applyTheme(document.documentElement.dataset.theme || "dark");
$("menuTheme")?.addEventListener("click", (e) => {
  e.stopPropagation(); // keep the menu open while toggling
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

// Pairing is account-wide: a QR button sits next to the avatar and opens a
// large QR in the middle of the screen.
function closePairModal() {
  $("pairModal")?.classList.add("hide");
}

/**
 * Pairing links cost two round trips (mint the token, render the QR) and the deployed
 * host takes seconds over each. Mint one in the background when the dashboard loads so
 * the modal opens with a code already in it, and keep it until it is close to expiring.
 */
const PAIR_LINK_TIMEOUT_MS = 8000;
const PAIR_LINK_REFRESH_MS = 60_000;
let pairLinkPending = null;

async function getPairLink(force = false) {
  const fresh =
    state.pairLink && state.pairLink.expiresAt - Date.now() > PAIR_LINK_REFRESH_MS;
  if (!force && fresh) return state.pairLink;
  if (pairLinkPending) return pairLinkPending;
  pairLinkPending = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAIR_LINK_TIMEOUT_MS);
    try {
      // `silent` on purpose: a 403 here used to open window.prompt, which blocks the
      // whole page and reads as "Generating…" forever.
      const data = await api("/api/v1/devices/pairing", {
        method: "POST",
        silent: true,
        signal: ctrl.signal,
      });
      const qr = `/api/v1/qr?data=${encodeURIComponent(data.url)}`;
      state.pairLink = {
        url: data.url,
        qr,
        expiresAt: Date.parse(data.expiresAt) || Date.now() + 10 * 60_000,
      };
      // Warm the image too, so the modal has pixels to show the moment it opens.
      new Image().src = qr;
      return state.pairLink;
    } finally {
      clearTimeout(timer);
      pairLinkPending = null;
    }
  })();
  return pairLinkPending;
}
async function showPairLink() {
  const retry = $("pairModalRetry");
  retry?.classList.add("hide");
  $("pairModalQr").removeAttribute("src");
  $("pairModalQr").classList.add("hide");
  $("pairModalUrl").textContent = "Generating…";
  try {
    const link = await getPairLink();
    const img = $("pairModalQr");
    img.src = link.qr;
    // Wait for the pixels: revealing the box first is what made the modal look empty
    // while the QR was still on its way.
    await img.decode?.().catch(() => {});
    img.classList.remove("hide");
    $("pairModalUrl").textContent = link.url;
  } catch (err) {
    const offline = err?.name === "AbortError" || /failed to fetch|network/i.test(err?.message || "");
    $("pairModalUrl").textContent = offline
      ? "No answer from the server - retry"
      : err.message || "Couldn't create a pairing link";
    retry?.classList.remove("hide");
  }
}

$("pairQrBtn")?.addEventListener("click", async () => {
  const modal = $("pairModal");
  if (!modal) return;
  modal.classList.remove("hide");
  await showPairLink();
});
$("pairModalRetry")?.addEventListener("click", async () => {
  $("pairModalRetry")?.classList.add("hide");
  await showPairLink();
});
$("pairModalClose")?.addEventListener("click", closePairModal);
$("pairModal")?.addEventListener("click", (e) => {
  if (e.target === $("pairModal")) closePairModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePairModal();
});
$("pairModalCopy")?.addEventListener("click", async () => {
  const url = $("pairModalUrl")?.textContent;
  if (!url || url === "-" || url === "Generating…") return;
  try {
    await navigator.clipboard.writeText(url);
    toast("Pairing link copied");
  } catch {
    toast("Copy failed");
  }
});

$("menuCopyKey")?.addEventListener("click", async (e) => {
  e.stopPropagation(); // copying must not close the menu
  if (!store.apiKey) return toast("No account key in this session");
  try {
    await navigator.clipboard.writeText(store.apiKey);
    toast("Account key copied");
  } catch {
    toast("Copy failed");
  }
});
$("menuCreateSecret")?.addEventListener("click", async (e) => {
  e.stopPropagation(); // keep the menu open while the secret is shown
  const btn = $("menuCreateSecret");
  btn.disabled = true;
  try {
    const data = await api("/api/v1/me/secret", { method: "POST" });
    state.secretKey = data.secretKey;
    $("menuSecretKey").innerHTML = maskedKey(data.secretKey);
    $("menuCopySecret").classList.remove("hide");
    btn.classList.add("hide");
    toast("Secret key generated");
  } catch (err) {
    toast(err.message || "Couldn't create secret");
  } finally {
    btn.disabled = false;
  }
});
$("menuCopySecret")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  let v = state.secretKey;
  if (!v) {
    // Not in memory this session - ask the server to reveal it.
    try {
      const data = await api("/api/v1/me/secret/reveal", { method: "POST" });
      v = data.secretKey;
      state.secretKey = v;
    } catch (err) {
      return toast(err.message || "Secret key is not available");
    }
  }
  try {
    await navigator.clipboard.writeText(v);
    toast("Secret key copied");
  } catch {
    toast("Copy failed");
  }
});
/**
 * Credit requests. Until a payment provider sits in front of this, the
 * purchase settles immediately (the server only allows it outside prod).
 */
async function addRequests(count, btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>Adding requests…`;
  try {
    const data = await api("/api/v1/me/tokens", {
      method: "POST",
      body: count ? { requests: count } : {},
    });
    toast(
      data.direct
        ? `${data.added.toLocaleString()} requests added - free while payments are being approved`
        : `${data.added.toLocaleString()} requests added`,
    );
    // A request held back for the limit is actionable again now: refetch so the
    // card unlocks instead of staying disabled until the next page load.
    await loadMenu();
    await loadApprovals();
    await loadAccount();
  } catch (err) {
    // A host with payments configured refuses the free grant, which is the signal to
    // hand the browser to the hosted checkout rather than inventing tokens.
    if (/billing provider/i.test(err.message || "")) {
      try {
        const { url } = await api("/api/v1/billing/checkout", {
          method: "POST",
          body: count ? { requests: count } : {},
        });
        window.location.href = url;
        return;
      } catch (payErr) {
        toast(payErr.message || "Couldn't start checkout");
      }
    } else {
      toast(err.message || "Couldn't add requests");
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}
/**
 * The pack menu. Prices come from the server so the surface cannot drift from what is
 * charged, and the entry pack reads as free while an account has not taken it yet.
 */
function renderPacks(me, ws) {
  const host = $("menuPacks");
  if (!host) return;
  const freeAvailable = !!ws.claimed && !ws.freePackClaimed;
  const packs = me.packs || [];
  /**
   * No packs and nothing left to give: say so. An empty menu is what made the button
   * look broken in the first place.
   */
  if (!packs.length) {
    const spent = me.directRemaining === 0;
    host.innerHTML = `<span class="menu-item muted" style="cursor:default">${icon("cart", 16)}${
      spent
        ? "Free requests used - packs go on sale when checkout is approved"
        : "No packs available on this workspace"
    }</span>`;
    return;
  }
  host.innerHTML = packs
    .map((p) => {
      const free = p.freeOnce && freeAvailable;
      // `free` on a pack means no provider is live yet: the pack settles on the spot,
      // so the label must not promise a checkout that does not exist.
      const label = free
        ? `Get ${p.requests.toLocaleString()} requests free`
        : p.free
          ? `Add ${p.requests.toLocaleString()} requests (free for now)`
          : p.priceEur > 0
            ? `Buy ${p.requests.toLocaleString()} requests (€${p.priceEur})`
            : `Get ${p.requests.toLocaleString()} requests (free)`;
      return `<button class="menu-item" data-pack="${p.requests}" data-free="${free ? "1" : "0"}">${icon("cart", 16)}${label}</button>`;
    })
    .join("");
}

/** The one-per-account free entry pack. The server owns "once", so a refusal is final. */
async function takeFreePack(btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>Adding requests…`;
  try {
    const data = await api("/api/v1/me/tokens/free", { method: "POST" });
    toast(`${data.added.toLocaleString()} free requests added`);
    await loadMenu();
    await loadApprovals();
    await loadAccount();
  } catch (err) {
    toast(err.message || "Couldn't take the free pack");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

$("menuPacks")?.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-pack]");
  if (!btn) return;
  e.stopPropagation(); // keep the menu open so the new balance is visible
  if (btn.dataset.free === "1") void takeFreePack(btn);
  else void addRequests(Number(btn.dataset.pack), btn);
});
$("menuRequests")?.addEventListener("click", () => {
  $("avatarMenu")?.classList.add("hide");
  const card = document.querySelector(".channel-card[data-id]");
  if (!card) return;
  renderChannels();
  card.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("claimBadge")?.addEventListener("click", () => showAuth());

/* --------------------------- new channel (inline) ---------------------- */

let createdChannel = null;

/** First free default channel name: Default, Default 1, Default 2, … */
function nextDefaultName() {
  const names = new Set(state.connections.map((c) => c.name));
  if (!names.has("Default")) return "Default";
  let i = 1;
  while (names.has(`Default ${i}`)) i++;
  return `Default ${i}`;
}
const NEW_CHANNEL_COLORS = [
  "#6c8cff", "#34c759", "#f59e0b", "#e0662b", "#d946ef",
  "#14b8a6", "#f43f5e", "#8b5cf6", "#06b6d4", "#ec4899",
];

/**
 * In-page colour picker (Pickr) - anchored to a swatch, never the native one.
 * `onSave` gets the hex once the human confirms.
 */
function attachPickr(swatch, initial, onSave) {
  if (!swatch || typeof Pickr !== "function") return null;
  const pickr = Pickr.create({
    el: swatch,
    theme: "nano",
    default: initial,
    swatches: NEW_CHANNEL_COLORS,
    components: {
      preview: true,
      opacity: false,
      hue: true,
      interaction: { hex: true, input: true, save: true },
    },
  });
  // Pickr does not always pick the colour up from the element, so set it.
  pickr.setColorRepresentation("HEXA");
  pickr.setColor(initial);
  pickr.on("save", (color) => {
    pickr.hide();
    onSave(color.toHEXA().toString());
  });
  return pickr;
}

// Pickr instances live outside the card DOM, so re-rendering must tidy them up.
let channelPickrs = [];
function resetChannelPickrs() {
  for (const p of channelPickrs) {
    try {
      p.destroyAndRemove();
    } catch {
      /* already gone */
    }
  }
  channelPickrs = [];
}

let newChannelHex = NEW_CHANNEL_COLORS[0];
let newChannelPickr = null;
function ensureNewChannelPickr() {
  const swatch = document.getElementById("newChannelColor");
  if (!swatch || newChannelPickr) return;
  newChannelPickr = attachPickr(swatch, newChannelHex, (hex) => {
    newChannelHex = hex;
  });
}

$("newChannelBtn")?.addEventListener("click", () => {
  const form = $("newChannelForm");
  // Opening only. Toggling would close an open form, and the next press would
  // reopen it with a fresh random colour - a flash for a press that should do
  // nothing at all. Closing stays with the blur and Escape paths below.
  openerBusy = false;
  if (!form?.classList.contains("hide")) {
    // Already open: do nothing, but leave the caret where the press was aimed.
    $("newChannelName")?.focus();
    return;
  }
  form.classList.remove("hide");
  ensureNewChannelPickr();
  // A fresh colour each time, so new channels look distinct by default.
  if (!$("newChannelName").value) {
    newChannelHex = NEW_CHANNEL_COLORS[Math.floor(Math.random() * NEW_CHANNEL_COLORS.length)];
    newChannelPickr?.setColor(newChannelHex);
  }
  $("newChannelName")?.focus();
});
/**
 * The form has no Create or Cancel button: naming the channel is the whole
 * gesture, and it can be renamed or removed afterwards like any other. A colour
 * popup is still part of this form, so interacting with it must not count as
 * leaving, or the channel would be created mid-selection.
 */
let colorPopupBusy = false;
/* Pressing the button that opens the form is not leaving it either - without
   this the blur that follows would create the draft, or close it and let the
   click reopen it. Recomputed on every press, so it clears itself. */
let openerBusy = false;
document.addEventListener(
  "pointerdown",
  (e) => {
    colorPopupBusy = !!e.target?.closest?.(".pcr-app, .pickr");
    openerBusy = !!e.target?.closest?.("#newChannelBtn");
  },
  true,
);

function closeNewChannelForm() {
  $("newChannelForm")?.classList.add("hide");
  const field = $("newChannelName");
  if (field) field.value = "";
}

async function createNewChannel({ allowDefault = false } = {}) {
  const typed = $("newChannelName")?.value.trim() ?? "";
  // Enter on an empty field still makes a channel; clicking away does not.
  const name = typed || (allowDefault ? nextDefaultName() : "");
  if (!name) return;
  const color = newChannelHex;
  try {
    const data = await api("/api/v1/channels", { method: "POST", body: { name } });
    // Create doesn't take a colour, so apply the chosen one right after.
    if (color && data.connection?.id) {
      await api(`/api/v1/channels/${data.connection.id}`, {
        method: "PATCH",
        body: { color },
      }).catch(() => {});
    }
    createdChannel = data;
    // Created: close the panel, then scroll to the new channel card.
    closeNewChannelForm();
    toast(`Channel "${data.connection.name}" created`);
    await loadConnectionsList();
    requestAnimationFrame(() => {
      document
        .querySelector(`.channel-card[data-id="${data.connection.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  } catch (err) {
    toast(err.message || "Couldn't create channel");
  }
}
$("newChannelName")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void createNewChannel({ allowDefault: true });
  }
  // Escape abandons the draft instead of creating it.
  if (e.key === "Escape") {
    e.preventDefault();
    closeNewChannelForm();
  }
});
$("newChannelName")?.addEventListener("blur", (e) => {
  if (colorPopupBusy || openerBusy) return;
  if (e.relatedTarget && $("newChannelForm")?.contains(e.relatedTarget)) return;
  const typed = $("newChannelName")?.value.trim();
  if (!typed) {
    closeNewChannelForm();
    return;
  }
  void createNewChannel();
});
/* ------------------------------- socket -------------------------------- */

/* The page paints before it knows whether it is signed in, so it holds a spinner
   until connect() picks a branch. Removed rather than hidden: nothing needs it again,
   and a re-render must never bring it back. */
/**
 * Inline "working" state for a button: the label stays put and a spinner appears after it, so
 * a slow round trip reads as progress instead of a dead control. Restoring is the caller's
 * job, because every one of these paths can fail as well as succeed.
 */
function setBusy(btn, on = true) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.idleLabel == null) btn.dataset.idleLabel = btn.textContent || "";
    const label = document.createTextNode(btn.dataset.idleLabel);
    const spin = document.createElement("span");
    spin.className = "spinner btn-spinner";
    spin.setAttribute("aria-hidden", "true");
    btn.replaceChildren(label, spin);
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  } else if (btn.dataset.idleLabel != null) {
    btn.textContent = btn.dataset.idleLabel;
    delete btn.dataset.idleLabel;
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

function clearBootLoader() {
  document.getElementById("bootLoader")?.remove();
}

/**
 * connect() is not the only way onto the screen: a 401 from the API, a sign-out, and a
 * deep link all reveal the gate by flipping the section's class. Watching the two
 * sections means the spinner cannot outlive the page it was standing in for, whichever
 * path got there first. Without this, a signed-out visitor saw "Loading…" above a
 * sign-in form that had been ready for seconds.
 */
function watchForFirstPaint() {
  for (const id of ["unpaired", "paired"]) {
    const section = document.getElementById(id);
    if (!section) continue;
    new MutationObserver(() => {
      if (!section.classList.contains("hide")) clearBootLoader();
    }).observe(section, { attributes: true, attributeFilter: ["class"] });
    if (!section.classList.contains("hide")) clearBootLoader();
  }
}
// A stuck loader would hide the whole app, so it gives up on its own even if the
// branch never resolves.
setTimeout(clearBootLoader, 12000);
watchForFirstPaint();

function connect() {
  const credential = store.apiKey || store.token;
  if (!credential) {
    clearBootLoader();
    els.unpaired.classList.remove("hide");
    els.paired.classList.add("hide");
    setSessionChrome(false);
    return;
  }
  // Never stack sockets: a reconnect or a tab focus must reuse the live one.
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  els.unpaired.classList.add("hide");
  els.paired.classList.remove("hide");
  clearBootLoader();
  // Signed in: the channel + pairing actions belong to the app, not to the gate.
  setSessionChrome(true);
  // Signing in can land straight on the archive page (a bookmark, a reload there).
  renderView();
  // Fade in once, on the first load. Reconnects keep the page steady instead
  // of flashing it out and back in (which looks like a reload).
  if (state.everReady) {
    els.paired.classList.add("ready");
  } else {
    els.paired.classList.remove("ready");
    clearTimeout(connect._ready);
    connect._ready = setTimeout(() => {
      state.everReady = true;
      els.paired.classList.add("ready");
    }, 1500);
  }
  status("", "Connecting…");

  // Load data over HTTP right away - don't wait for the WebSocket `hello`,
  // which can be slow through a tunnel.
  void loadApprovals();
  void loadConnectionsList();
  void loadAccount();
  void loadMenu();
  // Pull the account secret into memory up front so pairing a device (and any
  // other manage action) never interrupts with a prompt.
  void loadSecretKey();
  // Mint the pairing link now, not when the QR button is pressed: the two round
  // trips are seconds apart from the click on a small host, which read as a hang.
  void getPairLink().catch(() => {});

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(credential)}`);
  state.ws = ws;

  ws.onopen = () => {
    state.reconnect = 800;
    status("online", "Live");
    startHeartbeat();
  };
  ws.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(frame);
  };
  ws.onclose = (event) => {
    // Ignore a stale socket closing after a newer one has taken over.
    if (state.ws !== ws) return;
    stopHeartbeat();
    state.ws = null;
    if (event.code === 4401) {
      // 4401 means "not authorised" - but that is often transient (a server
      // restart, a tunnel blip). Only sign out when the API actually rejects
      // the key; otherwise keep it and retry.
      void (async () => {
        if (await credentialStillValid()) {
          status("offline", "Reconnecting…");
          setTimeout(connect, 1500);
          return;
        }
        const hadAccountKey = !!store.apiKey;
        store.token = null;
        store.apiKey = null;
        status("offline", "Not paired");
        if (hadAccountKey) {
          toast("This account key is no longer valid - ask your agent for a fresh sign-in link.");
        }
        els.unpaired.classList.remove("hide");
        els.paired.classList.add("hide");
        // `connect()` already showed the signed-in nav before the socket
        // rejected us, so take it back down with the panel.
        setSessionChrome(false);
      })();
      return;
    }
    status("offline", "Reconnecting…");
    setTimeout(connect, state.reconnect);
    state.reconnect = Math.min(state.reconnect * 1.7, 15000);
  };
  ws.onerror = () => ws.close();
}

function refresh() {
  void loadApprovals();
  void loadConnectionsList();
}

function handle(frame) {
  switch (frame.type) {
    case "hello":
      store.workspace = frame.workspace;
      if (frame.workspace?.baseUrl) publicBaseUrl = frame.workspace.baseUrl;
      state.device = frame.device;
      state.pending.clear();
      for (const p of frame.pending || []) state.pending.set(p.id, p);
      refresh();
      maybeWelcomeTest();
      state.everReady = true;
      els.paired.classList.add("ready");
      break;
    case "prompt.created":
      state.pending.set(frame.prompt.id, frame.prompt);
      // On screen at the frame, not two round trips later.
      renderApprovalCard();
      invalidateHistory(frame.prompt.connectionId);
      refresh();
      toast(frame.prompt.title || "Approval needed");
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      break;
    case "prompt.decided": {
      // The decided prompt is what names its channel, so read it before dropping it.
      invalidateHistory(state.pending.get(frame.promptId)?.connectionId);
      state.pending.delete(frame.promptId);
      // Answered somewhere else - the notch, another tab, another phone - so the
      // card goes now. It used to wait for two reads, and a failed read left the
      // answered card on screen as if it were still waiting.
      renderApprovalCard();
      refresh();
      break;
    }
      break;
    case "decision.ack":
      // The socket path updates optimistically on the way out, so a refusal has to be shown and
      // the list re-read. Nothing was written, so the request is still waiting.
      if (frame.applied === false) {
        markOutOfRequests(null, frame.promptId, frame.message || frame.reason);
        void loadApprovals();
      }
      break;
    case "pong":
      break;
  }
}

/**
 * Is the stored credential still accepted? A 401 means it is genuinely gone;
 * anything else (403 scope, offline, 5xx) means keep it.
 */
async function credentialStillValid() {
  const headers = {};
  if (store.apiKey) headers["x-psh-key"] = store.apiKey;
  else if (store.token) headers["x-psh-device"] = store.token;
  else return false;
  try {
    const res = await fetch("/api/v1/me", { headers });
    return res.status !== 401;
  } catch {
    return true; // network problem, not an auth problem
  }
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeat = setInterval(() => send({ type: "ping" }), 25000);
}
function stopHeartbeat() {
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.heartbeat = null;
}

/* ------------------------------ approvals ------------------------------ */

function channelById(id) {
  return state.connections.find((c) => c.id === id);
}

function relTime(ts) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  // Compact, and no space inside the unit: "5d ago" is a timestamp, "5 d ago"
  // reads like a typo in a column narrow enough to be doing the reader a favour.
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function historyRow(channelId) {
  return `
    <button class="history-row" data-history="${esc(channelId)}">
      <span class="history-label">${icon("clock", 15)} History</span>
      <span class="chev">${icon("chevron-down", 15)}</span>
    </button>
    <div class="history-body hide" id="hist-${esc(channelId)}"></div>`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function channelSection(c) {
  const accent = c.color || "";

  // Pending requests already show in the big card up top, so the channel card
  // only carries its identity and an optional history.
  const histOpen = state.channelHistOpen[c.id] ?? false;
  return `
    <section class="channel-card" data-id="${esc(c.id)}"${accent ? ` style="--accent:${esc(accent)}"` : ""}>
      <header class="ch-head">
        <span class="ch-color" data-color="${esc(c.id)}" style="background:${esc(accent || "#6c8cff")}" title="Accent colour"></span>
        <h3 class="ch-name" data-name="${esc(c.id)}" title="Double-click to rename">${esc(c.name)}</h3>
        <button class="btn pill ch-copy" data-cpnew="${esc(c.id)}">${icon("copy", 15)}<span class="ch-copy-label">Copy prompt for agent</span><span class="ch-copy-caret" data-cpeye="${esc(c.id)}">${icon("chevron-down", 14)}</span></button>
        <span class="ch-spacer"></span>
        <span class="ch-share-wrap">
          <button class="icon-btn ch-share" data-share="${esc(c.id)}" aria-label="Who's in this channel" aria-expanded="false" title="Who's in this channel">${icon("share", 16)}</button>
          <div class="menu ch-share-menu hide" id="share-${esc(c.id)}">
            <div class="menu-field share-link" id="sharelink-${esc(c.id)}"></div>
            <div class="share-body" id="sharebody-${esc(c.id)}"><div class="share-empty">Loading…</div></div>
          </div>
        </span>
        <span class="ch-more-wrap">
          <button class="icon-btn ch-more" data-more="${esc(c.id)}" aria-label="More actions" aria-expanded="false">${icon("more-vertical", 16)}</button>
          <div class="menu ch-more-menu hide" id="more-${esc(c.id)}">
            <button class="menu-item" data-rename="${esc(c.id)}">${icon("pencil", 15)}Rename</button>
            <button class="menu-item" data-csv="${esc(c.id)}">${icon("download", 15)}Export history (CSV)</button>
            <button class="menu-item" data-archive="${esc(c.id)}">${icon("archive", 15)}Archive channel</button>
          </div>
        </span>
        <button class="icon-btn ch-fold" data-hist="${esc(c.id)}" aria-label="${histOpen ? "Hide" : "Show"} request history" aria-expanded="${histOpen}">${icon("chevron-down", 16)}</button>
      </header>

      <pre class="ch-prompt hide" id="cprompt-${esc(c.id)}">-</pre>
      <a class="ch-prompt-more hide" id="cpromptmore-${esc(c.id)}" href="/docs#templates" target="_blank" rel="noreferrer">More prompt templates<span aria-hidden="true">→</span></a>

      <div class="ch-history ${histOpen ? "" : "hide"}" id="hist-${esc(c.id)}"></div>
    </section>`;
}

/* ------------------------------ approvals ------------------------------ */

// One page now: the pending approval sits above the channel list.

function render() {
  renderChannels();
}

/**
 * The single pending approval, rendered above the search bar. No history -
 * the channel cards carry their own request/history sections.
 */
function renderApprovalCard() {
  const el = els.approvals;
  if (!el) return;
  // Oldest first, and every pending ask gets its own card: showing only the
  // newest one read as "there is one waiting" while several were queued.
  const pending = [...state.pending.values()].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );

  if (!pending.length) {
    el.innerHTML = `<div class="approvals-empty">
        <div class="approvals-empty-mark">${icon("check", 28)}</div>
        <h2>No approvals right now</h2>
        <p class="muted">When an agent needs a decision, it appears here.</p>
      </div>`;
    document.body.classList.remove("has-backlog");
    document.title = "psh.now";
    return;
  }

  // The scroll position survives a re-render: a new ask is appended at the
  // bottom, so the cards above it must not jump back to the top.
  const list = el.querySelector(".approvals-list");
  const scrollTop = list?.scrollTop ?? 0;

  const single = pending.length === 1 ? " is-single" : "";
  el.innerHTML = `<div class="approvals-list${single}">${pending.map(approvalCard).join("")}</div>`;
  if (scrollTop) el.querySelector(".approvals-list")?.scrollTo({ top: scrollTop });

  // Make a backlog obvious even when the tab is not focused.
  document.body.classList.toggle("has-backlog", pending.length > 1);
  document.title = pending.length > 1 ? `(${pending.length}) psh.now` : "psh.now";

  for (const btn of el.querySelectorAll("[data-ap]")) {
    const id = btn.dataset.ap;
    btn.onclick = () =>
      decide(
        id,
        btn.dataset.a === "approve",
        btn.closest(".approval-card"),
        btn.dataset.decision || null,
      );
  }
}

/*
 * The mark and colour for an agent we recognise.
 *
 * `agent` is free text (up to 120 characters, whatever the hook sent), so it is
 * normalised to letters and digits before matching. An agent we do not know gets
 * no chip at all rather than a wrong one, and falls back to the plain name.
 *
 * These colours are chosen as one family: rich enough to carry a white mark, no
 * two adjacent hues alike, and none of them orange.
 */
const AGENT_ART = (() => {
  const table = {};
  const defs = [
    ["openclaw", "#4f46e5", ["openclaw"]],
    ["claudecode", "#e11d48", ["claudecode", "claude", "anthropic"]],
    ["codex", "#059669", ["codex", "openaicodex"]],
    ["cursor", "#2563eb", ["cursor"]],
    ["hermes", "#7c3aed", ["hermes"]],
    ["cline", "#0891b2", ["cline"]],
    ["grokbot", "#475569", ["grokbot", "grok", "grokcli"]],
    ["perplexity", "#0d9488", ["perplexity", "pplx"]],
    ["opencode", "#9333ea", ["opencode"]],
    ["antigravity", "#c026d3", ["antigravity"]],
    ["gemini", "#0284c7", ["gemini", "geminicli"]],
    ["githubcopilot", "#65a30d", ["githubcopilot", "copilot", "ghcopilot"]],
    ["pi", "#16a34a", ["pi"]],
    ["muse", "#db2777", ["muse"]],
    ["instinct", "#dc2626", ["instinct"]],
  ];
  for (const [slug, bg, names] of defs) for (const n of names) table[n] = { slug, bg };
  return table;
})();

/** The slug and colour for an agent string, or null when it is not one we know. */
function agentArt(agent) {
  if (!agent) return null;
  const key = String(agent).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  if (AGENT_ART[key]) return AGENT_ART[key];
  // Tolerate a suffix, e.g. "claude-code-hook": the longest known name wins.
  let best = null;
  for (const name of Object.keys(AGENT_ART)) {
    if (name.length < 4 || !key.startsWith(name)) continue;
    if (!best || name.length > best.length) best = name;
  }
  return best ? AGENT_ART[best] : null;
}

/** The one line that says the workspace cannot pay. Used on the card and after a refusal. */
function limitLineHtml() {
  return `${icon("alert", 14)}<span>Limit exceeded</span><span class="limit-arrow">&rarr;</span><button type="button" class="link-btn" data-topup>Add requests</button>`;
}

/**
 * Say on the card that the workspace is out of requests. The server refuses the decision before
 * writing anything, so without this the press looks like it did nothing and the request is
 * simply there again on the next load.
 */
function markOutOfRequests(row, promptId, message) {
  const card = row || document.getElementById(`ap-${promptId}`);
  state.approvals = (state.approvals || []).map((p) =>
    p.id === promptId ? { ...p, limitReached: true } : p,
  );
  if (card) {
    card.classList.add("is-limited");
    card.querySelectorAll(".verdict").forEach((b) => (b.disabled = true));
    let line = card.querySelector(".approval-limit");
    if (!line) {
      line = document.createElement("p");
      line.className = "approval-limit";
      (card.querySelector(".approval-actions") || card).appendChild(line);
    }
    line.innerHTML = limitLineHtml();
  }
  toast(message || "Limit exceeded - add requests to answer this");
}

function approvalCard(p) {
  const c = state.connections.find((x) => x.id === (p.connectionId || p.sessionId));
  const accent = c?.color || "";
  // No channel name and no separate meta row: the colour now sits in front of the
  // request itself, which says which channel this belongs to in space the title
  // already used, instead of spending a whole line on it.
  // The agent's own mark, when the string it sent is one we recognise. It carries
  // its own colour, so it needs no accent from the channel.
  const art = agentArt(p.agent);
  const chip = art
    ? `<span class="agent-chip" style="background:${esc(art.bg)}" title="${esc(p.agent)}"><img src="/agenticons/agenticon-${esc(art.slug)}.svg" alt="" /></span>`
    : "";

  // Always the same small card: title, one message, Approve / Deny - unless
  // the workspace is out of requests, in which case it is recorded but locked.
  // The note shares the action row (left of the buttons) instead of sitting on
  // its own line above them.
  const limited = p.limitReached === true;
  return `
    <div class="approval-card${limited ? " is-limited" : ""}" id="ap-${esc(p.id)}"${accent ? ` style="--accent:${esc(accent)}"` : ""}>
      <h2 class="approval-title"><span class="approval-dot"${accent ? ` style="background:${esc(accent)}"` : ""}></span><span class="approval-title-text">${esc(p.title || "Approval request")}</span>${chip}</h2>
      <div class="approval-body">
      <p class="approval-msg">${esc(p.message || p.command || "")}</p>
      <div class="approval-actions">
        ${
          limited
            ? `<p class="approval-limit">${limitLineHtml()}</p>`
            : ""
        }
        <div class="verdicts">
          <button class="verdict deny" type="button" data-a="deny" data-ap="${esc(p.id)}" aria-label="Deny" title="Deny"${limited ? " disabled" : ""}>${icon("thumbs-down", 15)}</button>
          <button class="verdict answer" type="button" data-a="answer" data-ap="${esc(p.id)}" aria-label="Answer" title="Answer"${limited ? " disabled" : ""}>${icon("message", 15)}</button>
          <button class="verdict approve" type="button" data-a="approve" data-ap="${esc(p.id)}" aria-label="Approve" title="Approve"${limited ? " disabled" : ""}>${icon("thumbs-up", 15)}</button>
        </div>
      </div>
      <div class="answer-box hide" id="answerbox-${esc(p.id)}">
        <div class="answer-field">
          <textarea class="answer-input" rows="1" placeholder="Add a comment…" aria-label="Add a comment"></textarea>
        </div>
        <button class="answer-send" type="button" data-answer-send="${esc(p.id)}" aria-label="Send answer" title="Send answer">${icon("send", 18)}</button>
      </div>
      </div>
    </div>`;
}

async function loadApprovals() {
  try {
    const { prompts } = await api("/api/v1/approvals?limit=50");
    state.approvals = prompts || [];
    // Keep the live pending set in sync (the WS `hello` also fills it).
    for (const p of prompts || []) {
      if (p.status === "pending") state.pending.set(p.id, p);
      else state.pending.delete(p.id);
    }
    renderChannels();
  } catch {
    /* non-critical */
  }
}

function renderChannels() {
  resetChannelPickrs();
  renderApprovalCard();

  // Show every channel, so one you just created is visible right away.
  const all = state.connections.filter((c) => !c.archived);
  const query = channelQuery();
  const visible = query ? all.filter((c) => c.name.toLowerCase().includes(query)) : all;
  // The field stays out only when there is nothing at all to sift: with one or
  // two channels the list looked like it had failed to load. It is keyed off the
  // unfiltered list, so it never disappears out from under a query.
  $("channelSearchWrap")?.classList.toggle("hide", all.length === 0);

  if (!visible.length) {
    if (query) {
      els.openChannels.innerHTML = `
      <div class="empty-state">
        <h2>No channel matches “${esc(query)}”</h2>
        <div class="empty-actions">
          <button class="btn pill" id="emptyClearSearch">Clear search</button>
        </div>
      </div>`;
      document.getElementById("emptyClearSearch")?.addEventListener("click", () => clearChannelSearch(true));
      els.closedSection?.classList.add("hide");
      return;
    }
    els.openChannels.innerHTML = `
      <div class="empty-state">
        <h2>No channels yet</h2>
        <div class="empty-actions">
          <button class="btn pill primary" id="emptyNewChannel">${icon("plus", 15)} Create channel</button>
        </div>
      </div>`;
    document.getElementById("emptyNewChannel")?.addEventListener("click", () => $("newChannelBtn")?.click());
    els.closedSection?.classList.add("hide");
    return;
  }

  els.openChannels.innerHTML = visible.map(channelSection).join("");
  if (els.closedSection) {
    els.closedSection.classList.add("hide");
    els.closedChannels.innerHTML = "";
  }

  wireChannels();
}

function wireChannels() {
  const root = document.getElementById("paired");

  // The card chevron folds the history in and out.
  for (const btn of root.querySelectorAll("[data-hist]")) {
    btn.onclick = () => toggleChannelOpen(btn.dataset.hist);
  }
  // Clicking the row itself does the same thing, so a channel opens with one
  // click anywhere on it. Every control keeps its own job: the buttons, the
  // copy pill, the colour swatch, the … menu, the expanded history, and the
  // name (which is still double-click to rename).
  for (const card of root.querySelectorAll(".channel-card[data-id]")) {
    card.onclick = (e) => {
      // A control inside the card keeps its own job, and a click whose element has
      // already left the DOM is not a click on the card.
      if (!card.contains(e.target)) return;
      if (e.target.closest("button, a, input, select, .menu, .pickr, .pcr-app, .ch-name, .ch-history"))
        return;
      toggleChannelOpen(card.dataset.id);
    };
  }
  // Double-click the title or the URL to edit it in place.
  for (const el of root.querySelectorAll("[data-name]")) {
    el.ondblclick = () =>
      inlineEdit(el, el.textContent.trim(), (v) => renameChannel(el.dataset.name, v));
  }

  for (const row of root.querySelectorAll(".req-row[id]")) {
    const id = row.id.replace(/^p-/, "");
    const ap = row.querySelector('[data-a="approve"]');
    const dn = row.querySelector('[data-a="deny"]');
    if (ap) ap.onclick = () => decide(id, true, row);
    if (dn) dn.onclick = () => decide(id, false, row);
  }

  // A request may be answered in the human's own words instead of yes/no: the
  // third button swaps the card for a small composer.
  for (const btn of root.querySelectorAll("[data-a='answer']")) {
    // One button both ways: it opens the composer, and once that is open the
    // mark has become a chevron, so pressing it is the way back out.
    btn.onclick = () => openAnswerBox(btn.dataset.ap, !btn.closest(".verdicts")?.classList.contains("is-open"));
  }
  for (const btn of root.querySelectorAll("[data-answer-send]")) {
    btn.onclick = () => sendAnswer(btn.dataset.answerSend);
  }
  for (const box of root.querySelectorAll(".answer-input")) {
    const card = box.closest(".approval-card");
    const id = card?.id.replace(/^ap-/, "") ?? "";
    box.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        openAnswerBox(id, false);
      }
      // Cmd/Ctrl+Enter sends, matching every other composer in the app.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void sendAnswer(id);
      }
    };
    box.oninput = () => {
      growAnswerInput(box);
      const send = document.querySelector(`[data-answer-send="${id}"]`);
      if (send) send.disabled = !box.value.trim();
    };
  }

  // The caret lives INSIDE the copy button, so stop the click bubbling to it.
  for (const caret of root.querySelectorAll("[data-cpeye]")) {
    caret.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const el = document.getElementById(`cprompt-${caret.dataset.cpeye}`);
      const hidden = el?.classList.toggle("hide");
      // The snippet and the way onward appear together: the chevron is what reveals
      // both. `/docs#templates` indexes the other prompts (install, sandbox-by-key).
      document
        .getElementById(`cpromptmore-${caret.dataset.cpeye}`)
        ?.classList.toggle("hide", hidden);
      const btn = caret.closest(".ch-copy");
      btn?.setAttribute("aria-expanded", hidden ? "false" : "true");
      caret.classList.toggle("open", !hidden);
    };
  }

  // Share opens a dropdown listing who is already in the channel, with the
  // link itself at the bottom (that is what the owner copies and sends on).
  for (const btn of root.querySelectorAll("[data-share]")) {
    const id = btn.dataset.share;
    const menu = document.getElementById(`share-${id}`);
    if (menu) menu.onclick = (e) => e.stopPropagation();
    btn.onclick = async (e) => {
      e.stopPropagation();
      const opening = !!menu && menu.classList.contains("hide");
      for (const m of document.querySelectorAll(".ch-share-menu, .ch-more-menu")) m.classList.add("hide");
      for (const b of document.querySelectorAll("[data-share]")) b.setAttribute("aria-expanded", "false");
      if (!menu || !opening) return;
      menu.classList.remove("hide");
      btn.setAttribute("aria-expanded", "true");
      await loadShare(id);
    };
  }

  // `…` menu: rename, delete. (The channel URL is not editable - it is minted
  // with the channel and every agent that attached did so with that link.)
  for (const btn of root.querySelectorAll("[data-more]")) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = document.getElementById(`more-${btn.dataset.more}`);
      const open = menu && menu.classList.contains("hide");
      for (const m of document.querySelectorAll(".ch-more-menu")) m.classList.add("hide");
      menu?.classList.toggle("hide", !open);
    };
  }
  for (const btn of root.querySelectorAll("[data-rename]")) {
    btn.onclick = () => {
      btn.closest(".ch-more-menu")?.classList.add("hide");
      const name = root.querySelector(`.ch-name[data-name="${btn.dataset.rename}"]`);
      name?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    };
  }
  for (const btn of root.querySelectorAll("[data-csv]")) {
    btn.onclick = () => {
      btn.closest(".ch-more-menu")?.classList.add("hide");
      void exportHistory(btn.dataset.csv, btn);
    };
  }
  for (const btn of root.querySelectorAll("[data-cqr]")) {
    btn.onclick = () => {
      const qr = document.getElementById(`cqr-${btn.dataset.cqr}`);
      const hidden = qr?.classList.toggle("hide");
      btn.classList.toggle("active", !hidden);
    };
  }
  for (const btn of root.querySelectorAll("[data-cpnew]")) {
    btn.onclick = () => addAgentToChannel(btn.dataset.cpnew);
  }
  // Accent colour: an in-page picker anchored to each card's swatch.
  for (const swatch of root.querySelectorAll(".ch-color[data-color]")) {
    const id = swatch.dataset.color;
    const current = channelById(id)?.color || "#6c8cff";
    const pickr = attachPickr(swatch, current, (hex) => setChannelColor(id, hex));
    if (pickr) channelPickrs.push(pickr);
  }
  for (const btn of root.querySelectorAll("[data-pair]")) {
    btn.onclick = () => pairFromChannel(btn.dataset.pair, btn);
  }
  for (const btn of root.querySelectorAll("[data-archive]")) {
    btn.onclick = () => archiveChannel(btn.dataset.archive);
  }

  // Fill each channel's connect prompt, plus its history when it is unfolded.
  for (const card of root.querySelectorAll(".channel-card[data-id]")) {
    const id = card.dataset.id;
    void ensureChannelConnect(id);
    if (state.channelHistOpen[id]) void loadHistory(id);
  }
}

/**
 * The history table asks for the newest page first, not the whole channel: a
 * busy channel is a hundred rows and 50 KB of JSON, and all of it had to arrive
 * before the first row was drawn. `HIST_MAX` is the list's own ceiling
 * (`listPrompts` pages at 200); the CSV export is what reads further back.
 */
const HIST_PAGE = 30;
const HIST_MAX = 200;

/** Bind what the history rows can do (an agent name is renameable in place). */
function wireHistory(channelId) {
  const box = document.getElementById(`hist-${channelId}`);
  if (!box) return;
  for (const btn of box.querySelectorAll("[data-renameagent]")) {
    btn.onclick = () =>
      startKeyRename(
        channelId,
        btn.dataset.renameagent,
        btn,
        {
          // A nameless agent gets an empty field with a placeholder, not the
          // "Unnamed agent" text the cell shows.
          current: btn.dataset.agentname ?? "",
          onSaved: async () => {
            delete state.hist[channelId];
            await loadHistory(channelId);
            // The same key is listed in the share panel, if it happens to be open.
            if (!document.getElementById(`share-${channelId}`)?.classList.contains("hide"))
              await loadShare(channelId);
          },
        },
      );
  }
  for (const btn of box.querySelectorAll("[data-histmore]")) {
    btn.onclick = () => loadHistory(channelId, { limit: HIST_MAX, force: true });
  }
}

/** Fetch and render a channel's decided requests, from cache when we have it. */
async function loadHistory(channelId, { limit = HIST_PAGE, force = false } = {}) {
  const box = document.getElementById(`hist-${channelId}`);
  if (!box) return;

  // Re-opening a channel, or any re-render of the list, reuses what was drawn.
  const cached = state.hist[channelId];
  if (!force && cached && cached.limit >= limit) {
    box.innerHTML = cached.html;
    wireHistory(channelId);
    return;
  }

  box.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const { prompts } = await api(`/api/v1/channels/${channelId}?limit=${limit}`);
    const prev = (prompts || []).filter((p) => p.status !== "pending");
    const more = prev.length >= limit && limit < HIST_MAX;
    const html = prev.length
      ? `<div class="req-table hist-table">
          <div class="req-row req-head">
            <span>Agent</span><span>Request</span><span>Details</span><span>Time</span><span>Approved by</span><span>Status</span>
          </div>
          ${prev
            .map(
              (p) => `<div class="req-row">
                <span class="req-agent">${agentNameCell(p)}${p.agentId ? `<span class="req-sub" title="Agent ID">${esc(p.agentId)}</span>` : ""}</span>
                <span class="req-title">${esc(p.title || "Request")}</span>
                <span class="req-desc" title="${esc(p.message || p.command || "")}">${esc(p.message || p.command || "")}</span>
                <span class="req-desc">${esc(relTime(p.createdAt))}</span>
                <span class="req-desc req-by" title="${esc(p.decidedBy || "")}">${esc(p.decidedBy || "-")}</span>
                <span class="req-status"><span class="status-pill ${esc(p.status)}">${esc(p.status)}</span>${
                  p.answer ? `<span class="req-sub req-answer" title="${esc(p.answer)}">“${esc(p.answer)}”</span>` : ""
                }</span>
              </div>`,
            )
            .join("")}
        </div>${
          more
            ? `<button class="hist-more" data-histmore="${esc(channelId)}">Show older requests</button>`
            : ""
        }`
      : `<div class="muted">No previous requests.</div>`;
    state.hist[channelId] = { html, limit };
    // The channel may have been closed while this was in flight.
    const live = document.getElementById(`hist-${channelId}`);
    if (live) live.innerHTML = html;
    wireHistory(channelId);
  } catch (err) {
    const live = document.getElementById(`hist-${channelId}`);
    if (live) live.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
  }
}

/**
 * A decision changes a channel's history. Drop the cache so the next open is
 * fresh, and quietly re-read the one history that is on screen right now.
 */
function invalidateHistory(channelId) {
  if (!channelId) return;
  delete state.hist[channelId];
  if (state.channelHistOpen[channelId]) {
    clearTimeout(state.histTimer[channelId]);
    // Debounced: a burst of decisions is one re-read.
    state.histTimer[channelId] = setTimeout(() => loadHistory(channelId, { force: true }), 400);
  }
}

/**
 * The channel's decided requests, as a file.
 *
 * The file is built on the server and fetched through a signed URL the browser
 * navigates to, which is the only shape that downloads everywhere: a blob built
 * after an awaited fetch has already spent the click's user gesture, and Safari
 * refuses those, while a standalone web app on iOS has no download UI for one at
 * all. The URL carries no key, so nothing secret ends up in the address bar.
 */
async function exportHistory(channelId, btn) {
  const label = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon("download", 15)}Preparing…`;
  }
  try {
    const { url, count } = await api(`/api/v1/channels/${channelId}/export`, {
      method: "POST",
      body: {},
    });
    if (!count) {
      toast("Nothing decided in this channel yet");
      return;
    }
    window.location.assign(url);
    toast(`Exported ${count} ${count === 1 ? "request" : "requests"}`);
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }
}

/** "in 3 days" - for things that are still ahead of us (links, invites). */
function untilText(value) {
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff)) return "";
  if (diff <= 0) return "expired";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * The share menu: everyone already in the channel (people and agents), then the
 * invite link that adds more. The server stores only a hash of that link, so a
 * link minted earlier can be revoked but not re-shown - the owner makes a new one.
 */
async function loadShare(channelId) {
  const body = document.getElementById(`sharebody-${channelId}`);
  const linkBox = document.getElementById(`sharelink-${channelId}`);
  if (!body || !linkBox) return;

  try {
    const memRes = await api(`/api/v1/channels/${channelId}/members`).catch(() => ({ members: [] }));

    const members = memRes.members || [];
    // The owner's row names the account, never "You": a shared channel is not
    // always yours, and "You" on someone else's channel reads as a lie. An account
    // that never signed in with an email has none to show, so it keeps "You" for
    // its own owner and its id for everyone else.
    const owner = members.find((m) => m.role === "owner");
    const ownerIsMe = !!owner && owner.accountId === store.workspace?.id;
    const ownerLabel = owner?.email || (ownerIsMe ? "You" : owner?.accountId || "Owner");
    // Minting keys, renaming agents and rotating the invite link are the owner's
    // jobs. A member looking at someone else's channel gets the people list, which
    // is what they can act on. Unknown means owner: never hide a control because
    // the workspace id had not arrived yet.
    const canManage = !owner || !store.workspace?.id || ownerIsMe;

    // Keys and the invite link belong to the owner's view, so a member does not
    // ask for them: each is a 404 for controls that will not be drawn.
    const [keysRes, linkRes] = canManage
      ? await Promise.all([
          api(`/api/v1/channels/${channelId}/keys`).catch(() => ({ keys: [] })),
          // null, not {active:false}: "you cannot see this link" is not the same as
          // "this channel has no live link", and only the second one should mint.
          api(`/api/v1/channels/${channelId}/invite-link`).catch(() => null),
        ])
      : [{ keys: [] }, null];
    const keys = keysRes.keys || [];
    // People, not things: the channel's own invite link is the field above, so
    // its placeholder row is dropped here. `acceptedBy` marks an invite someone
    // already took up - that is a membership, and it is not removable as one.
    const people = members.filter((m) => m.role === "approver");
    const invites = members.filter((m) => m.role === "invited" && !m.acceptedBy && m.email);

    const removeBtn = (attrs, label) =>
      `<button class="icon-btn sm danger" ${attrs} title="${esc(label)}" aria-label="${esc(label)}">${icon("x", 13)}</button>`;

    const row = (name, meta, remove = "") =>
      `<div class="share-row">
        <span class="share-name">${esc(name)}</span>
        <span class="share-meta">${meta}${remove}</span>
      </div>`;

    const peopleRows = [
      row(ownerLabel, "owner"),
      ...people.map((m) =>
        row(
          m.email || m.accountId || m.id,
          "can approve",
          removeBtn(`data-removemember="${esc(m.accountId || m.id)}"`, `Remove ${m.email || "this person"}`),
        ),
      ),
      ...invites.map((i) =>
        row(
          i.email,
          i.revoked ? "link revoked" : i.expired ? "link expired" : "invited",
          i.revoked ? "" : removeBtn(`data-removeinvite="${esc(i.id)}"`, `Remove the invite for ${i.email}`),
        ),
      ),
    ].join("");

    // Agent rows carry a pencil: the name is cosmetic, so renaming is a click
    // on the row rather than a trip to the settings page.
    const agentRows = keys.length
      ? keys
          .map(
            (k) => `<div class="share-row" data-keyrow="${esc(k.id)}">
        <span class="share-name"><span class="share-name-text">${esc(k.name)}</span>
          <button class="icon-btn sm" data-renamekey="${esc(k.id)}" aria-label="Rename agent"
            title="Rename agent ${esc(k.name)}">${icon("pencil", 13)}</button>
          <button class="icon-btn sm" data-copykey="${esc(k.id)}" aria-label="Copy key for ${esc(k.name)}"
            title="Copy this agent's key">${icon("copy", 13)}</button>
        </span>
        <span class="share-meta">agent <code class="settings-id">${esc(k.id)}</code>
          ${removeBtn(`data-removekey="${esc(k.id)}"`, `Remove agent ${k.name}`)}
        </span>
      </div>`,
          )
          .join("")
      : `<div class="share-empty">No agents yet.</div>`;

    body.innerHTML =
      `<div class="share-section"><div class="share-label">People</div>${peopleRows}</div>` +
      (canManage
        ? `<div class="share-section"><div class="share-label">Agents</div>${agentRows}</div>`
        : "");

    if (canManage && linkRes) {
      await renderInviteLink(channelId, linkBox, linkRes);
    } else {
      // Nothing to mint and nothing to show: the link belongs to the owner.
      linkBox.innerHTML = "";
    }
    for (const btn of body.querySelectorAll("[data-renamekey]")) {
      btn.onclick = () =>
        startKeyRename(channelId, btn.dataset.renamekey, btn.closest(".share-row")?.querySelector(".share-name"), {
          onSaved: () => loadShare(channelId),
        });
    }
    for (const btn of body.querySelectorAll("[data-copykey]")) {
      btn.onclick = () => copyChannelKey(btn.dataset.copykey);
    }
    for (const btn of body.querySelectorAll("[data-removekey]")) {
      btn.onclick = () => revokeChannelKey(channelId, btn.dataset.removekey, () => loadShare(channelId));
    }
    for (const btn of body.querySelectorAll("[data-removeinvite]")) {
      btn.onclick = () => revokeChannelInvite(channelId, btn.dataset.removeinvite);
    }
    for (const btn of body.querySelectorAll("[data-removemember]")) {
      btn.onclick = () => unshareChannelMember(channelId, btn.dataset.removemember);
    }
  } catch (err) {
    body.innerHTML = `<div class="share-empty">${esc(err.message || "Couldn't load")}</div>`;
  }
}

/**
 * The channel's invite link: the URL, a copy button and a button that mints a new
 * one. No "create" step and no explaining: one link serves both audiences (an
 * agent that redeems it becomes a requester, a person who signs in becomes a
 * member) and it lives 24 hours. A channel with no live link gets one minted
 * quietly here, because arriving at a channel with an empty field and a button
 * is worse than arriving at a link.
 */
async function renderInviteLink(channelId, linkBox, link) {
  let url = state.inviteLinks[channelId] || link.url || null;
  let expiresAt = link.expiresAt ?? null;
  if (url) {
    state.inviteLinks[channelId] = url;
  } else {
    const { invite } = await api(`/api/v1/channels/${channelId}/invite-link`, { method: "POST" });
    url = invite.url;
    expiresAt = invite.expiresAt;
    state.inviteLinks[channelId] = url;
  }

  const rotateLabel = expiresAt
    ? `New link - this one stops working ${untilText(expiresAt)}`
    : "New link - this one stops working";
  linkBox.innerHTML = `
    <div class="menu-key">
      <code class="share-url" title="${esc(url)}">${esc(url)}</code>
      <button class="icon-btn sm" data-copylink="${esc(channelId)}" aria-label="Copy invite link"
        title="Copy invite link">${icon("copy", 14)}</button>
      <button class="icon-btn sm" data-newlink="${esc(channelId)}" title="${esc(rotateLabel)}"
        aria-label="New invite link">${icon("refresh", 15)}</button>
    </div>`;

  // The link box is re-rendered on every load, so bind its buttons here.
  for (const btn of linkBox.querySelectorAll("[data-newlink]")) {
    btn.onclick = () => createInviteLink(channelId);
  }
  for (const btn of linkBox.querySelectorAll("[data-copylink]")) {
    btn.onclick = () => copyInviteLink(channelId);
  }
}

/** The history's agent cell: the key's live name, and the way to set it. */
function agentNameCell(p) {
  const label = p.agentName || p.agent || (p.keyId ? "Unnamed agent" : "-");
  if (!p.keyId) return esc(label);
  const known = (p.agentName || p.agent || "").trim();
  return `<button class="req-agent-name" data-renameagent="${esc(p.keyId)}" data-agentname="${esc(known)}" title="Name this agent"
    aria-label="Name the agent ${esc(known || "that asked")}">${esc(label)}<span class="req-agent-pencil">${icon("pencil", 12)}</span></button>`;
}

/**
 * Rename an agent in place: an input opens where the label is, Enter (or
 * clicking away) saves, Escape cancels. The key id stays put - only the label
 * moves. The share panel's pencil and the request history's agent name both
 * come through here; `onSaved` re-renders whichever surface asked.
 *
 * The label element is *hidden*, never rewritten, and the input is inserted
 * beside it: that is what keeps the pencil (which lives inside the label) alive
 * through a cancel.
 */
function startKeyRename(channelId, keyId, labelEl, { current, onSaved } = {}) {
  const el = labelEl || document.querySelector(`[data-keyrow="${keyId}"] .share-name`);
  if (!el || el.classList.contains("is-editing")) return;
  // `current` is what the input starts with (empty for a nameless agent, so the
  // placeholder shows); the label keeps its own text for a cancel.
  const before = (current ?? el.textContent ?? "").trim();
  el.classList.add("is-editing");
  const input = document.createElement("input");
  input.className = "share-name-input";
  input.value = before;
  input.maxLength = 60;
  input.placeholder = "Agent name";
  input.setAttribute("aria-label", "Agent name");
  el.insertAdjacentElement("beforebegin", input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    input.remove();
    el.classList.remove("is-editing");
    if (!save || !next || next === before) return;
    try {
      await api(`/api/v1/channels/${channelId}/keys/${keyId}`, {
        method: "PATCH",
        body: { name: next },
      });
      toast("Agent renamed");
    } catch (err) {
      toast(err.message || "Couldn't rename the agent");
      return;
    }
    await (onSaved ? onSaved() : loadShare(channelId));
  };

  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

/** Remove a pending invite (or tidy up a dead one) from the channel. */
async function revokeChannelInvite(channelId, inviteId) {
  if (!window.confirm("Remove this invite? The link stops working.")) return;
  try {
    await api(`/api/v1/channels/${channelId}/invites/${inviteId}/revoke`, { method: "POST" });
    toast("Invite removed");
    await loadShare(channelId);
  } catch (err) {
    toast(err.message || "Couldn't remove the invite");
  }
}

/** Take a person's access to the channel away (their share, not their account). */
async function unshareChannelMember(channelId, accountId) {
  if (!window.confirm("Remove this person? They lose access to this channel.")) return;
  try {
    await api(`/api/v1/channels/${channelId}/invites/${accountId}`, { method: "DELETE" });
    toast("Person removed");
    await loadShare(channelId);
  } catch (err) {
    toast(err.message || "Couldn't remove the person");
  }
}

/** Mint a fresh invite link (retiring any earlier one). */
async function createInviteLink(channelId) {
  try {
    const { invite } = await api(`/api/v1/channels/${channelId}/invite-link`, { method: "POST" });
    state.inviteLinks[channelId] = invite.url;
    await loadShare(channelId);
    await navigator.clipboard.writeText(invite.url).catch(() => {});
    toast("Invite link copied");
  } catch (err) {
    toast(err.message || "Couldn't create an invite link");
  }
}

async function revokeInviteLink(channelId) {
  try {
    await api(`/api/v1/channels/${channelId}/invite-link`, { method: "DELETE" });
    delete state.inviteLinks[channelId];
    await loadShare(channelId);
    toast("Invite link revoked");
  } catch (err) {
    toast(err.message || "Couldn't revoke the link");
  }
}

async function copyInviteLink(channelId) {
  const url = state.inviteLinks[channelId];
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
  } catch {
    toast(url);
  }
}

/** Set a channel's accent colour. */
async function setChannelColor(channelId, color) {
  try {
    await api(`/api/v1/channels/${channelId}`, { method: "PATCH", body: { color } });
    const c = channelById(channelId);
    if (c) c.color = color;
    renderChannels();
  } catch (err) {
    toast(err.message || "Couldn't set colour");
  }
}

async function copyChannelKey(keyId) {
  try {
    const { key } = await api(`/api/v1/me/keys/${keyId}/reveal`);
    await navigator.clipboard.writeText(key);
    toast("Channel key copied");
  } catch (err) {
    toast(err.message || "Couldn't reveal key");
  }
}

async function renameKey(id, name) {
  try {
    await api(`/api/v1/me/keys/${id}`, { method: "PATCH", body: { name } });
    toast("Renamed");
  } catch (err) {
    toast(err.message || "Couldn't rename");
  }
}

async function revokeChannelKey(channelId, keyId, after) {
  if (!window.confirm("Remove this agent? Its key stops working immediately.")) return;
  try {
    await api(`/api/v1/channels/${channelId}/keys/${keyId}`, { method: "DELETE" });
    toast("Agent removed");
    if (after) await after();
    else {
      void loadShare(channelId);
      loadConnectionsList();
    }
  } catch (err) {
    toast(err.message || "Couldn't remove the agent");
  }
}

async function renameDevice(id, name) {
  try {
    await api(`/api/v1/devices/${id}`, { method: "PATCH", body: { name } });
    toast("Renamed");
  } catch (err) {
    toast(err.message || "Couldn't rename");
  }
}

async function revokeDeviceConn(channelId, id) {
  if (!window.confirm("Revoke this device?")) return;
  try {
    await api(`/api/v1/devices/${id}`, { method: "DELETE" });
    toast("Device revoked");
  } catch (err) {
    toast(err.message || "Couldn't revoke device");
  }
}

async function pairFromChannel(channelId, btn) {
  btn.disabled = true;
  try {
    const data = await api("/api/v1/devices/pairing", { method: "POST" });
    const qr = document.getElementById(`pairqr-${channelId}`);
    const url = document.getElementById(`pairurl-${channelId}`);
    const box = document.getElementById(`pairbox-${channelId}`);
    if (qr) qr.src = data.qrUrl;
    if (url) url.textContent = data.url;
    if (box) box.classList.remove("hide");
    try {
      await navigator.clipboard.writeText(data.url);
      toast("Pairing link copied");
    } catch {
      toast("Pairing link ready");
    }
  } catch (err) {
    toast(err.message || "Couldn't create link");
  } finally {
    btn.disabled = false;
  }
}

/** Swap an element for an input, commit on blur/Enter, revert on Escape. */
function inlineEdit(el, value, onCommit) {
  const input = document.createElement("input");
  input.className = "ch-inline-input";
  input.value = value;
  input.spellcheck = false;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    input.replaceWith(el);
    if (commit && next && next !== value) onCommit(next);
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
}

/** Rename a channel from the card header. */
async function renameChannel(channelId, name) {
  try {
    await api(`/api/v1/channels/${channelId}`, { method: "PATCH", body: { name } });
    const c = channelById(channelId);
    if (c) c.name = name;
    renderChannels();
  } catch (err) {
    toast(err.message || "Couldn't rename");
    renderChannels();
  }
}

async function archiveChannel(channelId) {
  if (!window.confirm("Archive this channel? It will be hidden from the list.")) return;
  try {
    await api(`/api/v1/channels/${channelId}/archive`, {
      method: "POST",
      body: { archived: true },
    });
    toast("Channel archived");
    loadConnectionsList();
  } catch (err) {
    toast(err.message || "Couldn't archive");
  }
}

async function newChannelJoinLink(channelId) {
  try {
    const data = await api(`/api/v1/channels/${channelId}/join-link`, { method: "POST" });
    const prompt = channelPrompt(data.url);
    const el = document.getElementById(`joinlink-${channelId}`);
    if (el) el.textContent = prompt;
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Connect prompt copied");
    } catch {
      toast("Connect link ready");
    }
  } catch (err) {
    toast(err.message || "Couldn't create link");
  }
}

/** Create (once per session) and show a channel's "connect an agent" prompt. */
async function ensureChannelConnect(channelId, force = false) {
  const el = () => document.getElementById(`cprompt-${channelId}`);
  const qr = () => document.getElementById(`cqr-${channelId}`);
  if (!force && state.channelConnect[channelId]) {
    const e = el();
    if (e) e.innerHTML = state.channelConnect[channelId].html;
    const q = qr();
    if (q && state.channelConnect[channelId].qr) q.src = state.channelConnect[channelId].qr;
    return state.channelConnect[channelId];
  }
  try {
    const data = await api(`/api/v1/channels/${channelId}/join-link`, { method: "POST" });
    const text = channelPrompt(data.url);
    const html = channelPrompt(data.url, { html: true });
    state.channelConnect[channelId] = { text, html, qr: "" };
    const e = el();
    if (e) e.innerHTML = html;
    // The header QR pairs THIS device (it signs you in) - it is NOT the agent
    // link above, which only hands an agent an ask-only key.
    void setChannelPairQr(channelId, force);
    return state.channelConnect[channelId];
  } catch {
    const e = el();
    if (e) e.textContent = "(couldn't create a link - open Connections)";
    return null;
  }
}

/**
 * Point a channel card's header QR at a device-pairing link. Scanning it opens
 * `/pair/:token`, which pairs the phone and drops it into the dashboard signed
 * in. The link is account-scoped, so one call covers every card.
 */
async function setChannelPairQr(channelId, force = false) {
  const q = document.getElementById(`cqr-${channelId}`);
  if (!q) return null;
  try {
    if (force || !state.pairQr) {
      state.pairQr = (await getPairLink(force)).qr;
    }
    const el = document.getElementById(`cqr-${channelId}`);
    if (el) {
      el.src = state.pairQr;
      el.classList.remove("hide");
    }
    const entry = state.channelConnect[channelId];
    if (entry) entry.qr = state.pairQr;
    return state.pairQr;
  } catch {
    // Pairing needs the account secret key. Say so instead of leaving a blank
    // box where the QR should be.
    markPairQrUnavailable();
    return null;
  }
}

/** Swap every header QR for an explicit "needs the secret key" state. */
function markPairQrUnavailable() {
  if (state.pairQrUnavailable) return;
  state.pairQrUnavailable = true;
  for (const el of document.querySelectorAll(".ch-qr")) {
    el.classList.add("hide");
    const note = document.createElement("span");
    note.className = "ch-qr-note";
    note.innerHTML = `${icon("key", 14)}<span>Add your account secret key to pair a device</span>`;
    el.insertAdjacentElement("afterend", note);
  }
  const hint = document.querySelector(".ch-qr-hint-text");
  if (hint) hint.textContent = "Pairing needs your secret key";
}

/** "Add agent": mint a fresh one-time link for this channel and copy the prompt. */
async function addAgentToChannel(channelId) {
  const entry = await ensureChannelConnect(channelId, true);
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.text);
    toast("Connect link copied - paste it to your agent");
  } catch {
    toast("Connect link ready");
  }
}

async function copyChannelConnect(channelId) {
  const entry = state.channelConnect[channelId];
  if (!entry) return toast("Link is still loading…");
  try {
    await navigator.clipboard.writeText(entry.text);
    toast("Connect prompt copied");
  } catch {
    toast("Copy failed");
  }
}



/** Expand/collapse a connection's previous (already-decided) requests. */
async function toggleHistory(connectionId, btn) {
  const list = document.getElementById(`hist-${connectionId}`);
  if (!list) return;
  const isOpen = !list.classList.contains("hide");
  if (isOpen) {
    list.classList.add("hide");
    btn.classList.remove("open");
    return;
  }

  if (!list.dataset.loaded) {
    list.innerHTML = `<div class="muted">Loading…</div>`;
    try {
      const { prompts } = await api(`/api/v1/channels/${connectionId}`);
      const prev = (prompts || []).filter((p) => p.status !== "pending");
      list.innerHTML = prev.length
        ? prev
            .map(
              (p) => `<div class="session-row">
                <span class="grow">${esc(p.title || p.message)}</span>
                <span class="status-pill ${p.status}">${p.status}</span>
              </div>`,
            )
            .join("")
        : `<div class="muted">No previous requests.</div>`;
      list.dataset.loaded = "1";
    } catch (err) {
      list.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
    }
  }
  list.classList.remove("hide");
  btn.classList.add("open");
}

/** Show or hide the free-text composer under a card's buttons. */
function openAnswerBox(promptId, open) {
  const box = document.getElementById(`answerbox-${promptId}`);
  const card = document.getElementById(`ap-${promptId}`);
  if (!box) return;
  box.classList.toggle("hide", !open);
  // The pill opens rather than steps aside: Deny and Approve fold away and the
  // composer takes their room, so the pill becomes the field itself. Its
  // `disabled` state (the out-of-requests lock) is untouched.
  card?.querySelector(".verdicts")?.classList.toggle("is-open", open);
  // Lets the action row fall to a full-width line of its own while it is open.
  const answerBtn = card?.querySelector('[data-a="answer"]');
  if (answerBtn) {
    answerBtn.title = open ? "Cancel" : "Answer";
    answerBtn.setAttribute("aria-label", open ? "Cancel" : "Answer");
  }
  if (open) {
    const input = box.querySelector(".answer-input");
    const send = box.querySelector("[data-answer-send]");
    if (send) send.disabled = !input?.value.trim();
    growAnswerInput(input);
    input?.focus();
  }
}

/**
 * Grow the answer field to fit what has been typed, so it starts at one line and
 * only takes the room the answer actually needs. Capped, after which it scrolls.
 */
function growAnswerInput(el) {
  if (!el) return;
  // Chromium counts the placeholder in scrollHeight once it wraps, so an empty
  // field measured as tall as its placeholder - three lines on a phone, which
  // is not the one line the composer is meant to be. Blank it for the measure;
  // it is restored in the same task, so nothing repaints in between.
  const placeholder = el.placeholder;
  if (!el.value) el.placeholder = "";
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  el.placeholder = placeholder;
}

/** Send the typed answer as the decision for that request. */
async function sendAnswer(promptId) {
  const box = document.getElementById(`answerbox-${promptId}`);
  const input = box?.querySelector(".answer-input");
  const answer = input?.value.trim() ?? "";
  if (!answer) {
    input?.focus();
    return;
  }
  const card = document.getElementById(`ap-${promptId}`);
  await decide(promptId, false, card, null, answer);
}

/**
 * Decide a request. `answer` is the human's own words: when present the request
 * is *answered* rather than approved or denied, and the agent reads the text.
 */
async function decide(promptId, approved, row, decision = null, answer = null) {
  const buttons = row.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  const kind = answer ? "answer" : approved ? "approve" : "deny";
  const active = row.querySelector(
    `[data-a="${kind}"]${decision ? `[data-decision="${decision}"]` : ""}`,
  );
  if (active) active.innerHTML = `<span class="spinner"></span>`;
  // `decision` carries the chosen route option id, so the agent learns which
  // path the human took rather than a bare yes. `answer` is free text.
  const frame = { type: "decision", promptId, approved };
  if (decision) frame.decision = decision;
  if (answer) frame.answer = answer;
  if (!send(frame)) {
    try {
      const res = await api(`/api/v1/approvals/${encodeURIComponent(promptId)}/decision`, {
        method: "POST",
        body: { approved, ...(decision ? { decision } : {}), ...(answer ? { answer } : {}) },
      });
      // Refused, and the reason is the limit: the card has to say so rather than leaving the
      // buttons looking live and the request apparently untouched.
      if (res && res.applied === false) {
        markOutOfRequests(row, promptId, res.reason);
        return;
      }
    } catch (err) {
      toast(err.message || "Couldn't reach server");
      buttons.forEach((b) => (b.disabled = false));
      return;
    }
  }
  state.pending.delete(promptId);
  state.approvals = (state.approvals || []).map((p) =>
    p.id === promptId
      ? {
          ...p,
          status: answer ? "answered" : approved ? "approved" : "denied",
          answer: answer || p.answer,
          decision: decision || p.decision,
        }
      : p,
  );
  renderChannels();
}

/* ------------------------------ connections ---------------------------- */

async function loadConnectionsList() {
  if (!store.apiKey && !store.token) return;
  try {
    const { connections } = await api("/api/v1/channels");
    state.connections = connections || [];
    render();
  } catch {
    /* non-critical */
  }
}

/* ------------------------------ test request --------------------------- */

async function sendTest(silent = false) {
  try {
    await api("/api/v1/test", { method: "POST" });
    if (!silent) toast("Test approval sent");
  } catch (err) {
    if (!silent) toast(err.message || "Couldn't send test");
  }
}

async function maybeWelcomeTest() {
  if (!state.welcome) return;
  state.welcome = false;
  history.replaceState({}, "", "/app");
  if (state.pending.size === 0) {
    await sendTest(true);
    toast("Sent a test approval - tap Approve");
  }
}

/* ------------------------------- account ------------------------------- */

const kvRow = (label, value) =>
  `<div class="kv"><span>${label}</span><span>${value}</span></div>`;

let pendingClaim = null;

function fmtUsage(u) {
  if (!u) return "-";
  const limit = u.limit == null ? "unlimited" : u.limit;
  return `${u.requestsToday} / ${limit}`;
}

async function loadAccount() {
  if (!store.apiKey && !store.token) return;
  // The minimal app has no account card; nothing to render there.
  if (!$("acctHandle")) return;
  try {
    const [me, prof] = await Promise.all([
      api("/api/v1/me"),
      api("/api/v1/profile").catch(() => null),
    ]);
    const ws = me.workspace || {};
    const registered = !!ws.email;
    const name = [ws.firstName, ws.lastName].filter(Boolean).join(" ").trim();

    // Identity is the name once set, otherwise the email, otherwise the key.
    $("acctHandle").textContent = name || ws.email || store.apiKey || "Anonymous";
    $("acctHandle").classList.toggle("is-key", !name && !ws.email);
    $("acctBadge").textContent = registered ? "Free" : "Anonymous";
    $("acctBadge").classList.toggle("free", registered);
    $("acctEdit").classList.toggle("hide", registered);
    if (registered) $("claimForm").classList.add("hide");

    // Out of free requests? Recommend registering. The limit comes from the
    // server (it owns the metering); only show the CTA when a real wall exists.
    const usage = me.usage || {};
    const outOfRequests =
      !registered && usage.limit != null && usage.requestsToday >= usage.limit;
    $("limitCta")?.classList.toggle("hide", !outOfRequests);

    renderAccountKey(store.apiKey);
    renderSecret(ws.hasSecret);
    renderBilling(me.usage, ws);
  } catch (err) {
    toast(err.message || "Couldn't load account");
  }
}

/**
 * Usage notices - the same card as the claim prompt. Shown when the workspace's
 * one lifetime allowance is nearly gone or gone, so the wall is visible before a
 * request is held back rather than only on the prompt that hit it.
 */
function renderUsageNotices(usage) {
  const host = $("appNotices");
  if (!host) return;
  const u = usage || {};
  const used = u.requestsToday ?? 0;
  const limit = u.limit;
  if (limit == null || limit <= 0) {
    host.innerHTML = "";
    return;
  }
  const out = used >= limit;
  if (!out && used / limit < 0.8) {
    host.innerHTML = "";
    return;
  }
  const left = Math.max(0, limit - used);
  const title = out
    ? "Out of requests"
    : `${left} request${left === 1 ? "" : "s"} left`;
  const body = out
    ? `All ${limit} used. New requests are recorded but locked until you add more.`
    : "You're close to running out of requests";
  // Everyone gets the action, anonymous workspaces included: topping up works
  // the same for them (the server takes a tenant or a device, not a login), and
  // adding requests is a different action from the Claim banner below, so the
  // two do not read as duplicates.
  const action = `<button class="btn pill primary sm" data-notice-act="topup">${icon("cart", 15)} Add requests</button>`;
  host.innerHTML = `
    <div class="app-notice${out ? " is-out" : ""}">
      <span class="app-notice-icon">${icon("alert", 20)}</span>
      <div class="app-notice-text">
        <strong>${esc(title)}</strong>
        <span>${esc(body)}</span>
      </div>
      ${action}
    </div>`;
  host.querySelector('[data-notice-act="topup"]')?.addEventListener("click", (e) => {
    // Keep the menu open: the document-level click handler would close it again.
    e.stopPropagation();
    openTopUp();
  });
}

/** Populate the account menu in the navbar. */
async function loadMenu() {
  if (!store.apiKey && !store.token) return;
  if (!$("menuName")) return;
  try {
    const [me, prof] = await Promise.all([
      api("/api/v1/me"),
      api("/api/v1/profile").catch(() => null),
    ]);
    const ws = me.workspace || {};
    if (ws.baseUrl) publicBaseUrl = ws.baseUrl;
    const key = store.apiKey || "";
    // Name first (what the human set), then a friendly default.
    const fullName = [ws.firstName, ws.lastName].filter(Boolean).join(" ").trim();
    $("menuName").textContent = fullName || "Anony Mous";
    $("menuEmail").textContent = ws.email || "No email yet";
    $("menuAccountKey").innerHTML = maskedKey(key);
    const registered = !!ws.email;
    $("claimBadge")?.classList.toggle("hide", registered);
    $("claimBanner")?.classList.toggle("hide", registered);
    renderUsageNotices(me.usage);
    // Test-only helper: top the account up without the payment page.
    renderPacks(me, ws);
    const badge = $("menuStatusBadge");
    if (badge) {
      const plan = (ws.plan || "anonymous").toLowerCase();
      badge.textContent = plan === "anonymous" ? "Anonymous" : plan[0].toUpperCase() + plan.slice(1);
      badge.className = `badge ${plan}`;
    }
    if (ws.hasSecret) {
      $("menuCreateSecret").classList.add("hide");
      // Every account is created with its secret now, so the reveal is always
      // available; the copy button mirrors whether the server can hand it back.
      $("menuCopySecret").classList.toggle("hide", !ws.hasSecretReveal);
      // Mask it exactly like the account key: prefix + blurred middle + last 4.
      void loadSecretKey().then((s) => {
        $("menuSecretKey").innerHTML = s
          ? maskedKey(s)
          : `${esc(ws.secretKeyPrefix || "psh_admin_")}…`;
      });
    }
    // Avatar: initial from the name; a stable-random colour per account.
    // Both go on :root as custom properties (see `.avatar::after`) so the
    // cached copy set by the inline head script can paint before this fetch
    // resolves - this call then only has to confirm it, never replace a
    // placeholder colour.
    const av = $("avatarBtn");
    if (av) {
      const initial = ((ws.firstName || ws.email || key || "?")[0] || "?").toUpperCase();
      const bg = avatarColor(ws.id || key || fullName || "anon");
      const root = document.documentElement;
      root.style.setProperty("--avatar-bg", bg);
      // JSON.stringify: `content:` needs a CSS string, not a bare token.
      root.style.setProperty("--avatar-initial", JSON.stringify(initial));
      root.dataset.avatar = "live";
      try {
        localStorage.setItem("psh.avatar", JSON.stringify({ bg, initial }));
      } catch {
        /* private mode / storage disabled: the avatar still renders, it just
           cannot be painted ahead of this fetch next time */
      }
    }
    const u = me.usage || {};
    const used = u.requestsToday ?? 0;
    const limit = u.limit ?? 0;
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    // The bar is always visible, even at 0%.
    if ($("menuBar")) $("menuBar").style.width = `${pct}%`;
    $("menuPct").textContent = limit ? `${used}/${limit} (${pct}%)` : `${used} used`;
  } catch {
    // Non-critical, but the avatar is the account-menu button and a hidden
    // button is not clickable either - so fall back to a neutral one rather
    // than leaving the menu unreachable. Only when nothing is cached; a cached
    // avatar is already on screen and stays.
    const root = document.documentElement;
    if (!root.dataset.avatar) {
      root.style.setProperty("--avatar-initial", JSON.stringify("?"));
      root.dataset.avatar = "fallback";
    }
  }
}

/** Show whether the admin secret exists; it is created here, never at install. */
function renderSecret(hasSecret) {
  const hint = $("secretHint");
  const create = $("secretCreate");
  if (!hint || !create) return;
  create.classList.toggle("hide", !!hasSecret);
  hint.textContent = hasSecret
    ? "Created. It administers the account - keep the copy you saved safe."
    : "Not created. It administers the account (keys, devices, channels).";
}

/** Show the prefix and last 4; blur the middle (a real blur, not dots). */
function renderAccountKey(key) {
  const el = $("acctKeyValue");
  if (!el) return;
  el.classList.remove("revealed");
  if (!key) {
    el.textContent = "(device session - no key)";
    return;
  }
  if (key.length <= 20) {
    el.textContent = key;
    return;
  }
  const prefix = key.slice(0, 12);
  const last = key.slice(-4);
  const middle = key.slice(12, -4);
  el.innerHTML = `${esc(prefix)}<span class="key-blur">${esc(middle)}</span>${esc(last)}`;
}

function renderBilling(usage, ws) {
  const box = $("billingUsage");
  if (!box) return;
  box.innerHTML =
    kvRow("Plan", esc(ws.plan || "anonymous")) +
    kvRow("Requests used", esc(fmtUsage(usage))) +
    kvRow("Token balance", String(ws.tokenBalance || 0));
}

$("acctEdit")?.addEventListener("click", () => {
  $("claimForm")?.classList.toggle("hide");
});
$("limitCtaBtn")?.addEventListener("click", () => {
  $("limitCta")?.classList.add("hide");
  $("claimForm")?.classList.remove("hide");
});
$("acctEye")?.addEventListener("click", () => {
  const el = $("acctKeyValue");
  const revealed = el?.classList.toggle("revealed");
  $("acctEye")?.querySelector(".eye-open")?.classList.toggle("hide", revealed);
  $("acctEye")?.querySelector(".eye-closed")?.classList.toggle("hide", !revealed);
});

$("acctRevealKey")?.addEventListener("click", () => {
  $("acctKeyValue").textContent = store.apiKey || "(device session - no key)";
});
$("acctCopyKey")?.addEventListener("click", async () => {
  if (!store.apiKey) return toast("No account key in this session");
  try {
    await navigator.clipboard.writeText(store.apiKey);
    toast("Account key copied - paste it into any new environment");
  } catch {
    toast("Copy failed");
  }
});
$("secretCreate")?.addEventListener("click", async () => {
  const btn = $("secretCreate");
  btn.disabled = true;
  try {
    const data = await api("/api/v1/me/secret", { method: "POST" });
    state.secretKey = data.secretKey; // hold in memory so manage actions work now
    $("secretValue").textContent = data.secretKey;
    $("secretResult").classList.remove("hide");
    $("secretHint").textContent = "Shown once - store it somewhere safe, never on an agent box.";
    btn.classList.add("hide");
    toast("Secret key created - save it");
  } catch (err) {
    toast(err.message || "Couldn't create secret");
  } finally {
    btn.disabled = false;
  }
});
$("secretCopy")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("secretValue").textContent);
    toast("Secret key copied");
  } catch {
    toast("Copy failed");
  }
});
$("rotateBtn")?.addEventListener("click", async () => {
  if (!window.confirm("Rotate the account key and secret? Every current key for this account stops working."))
    return;
  const btn = $("rotateBtn");
  btn.disabled = true;
  try {
    const data = await api("/api/v1/me/rotate", { method: "POST" });
    store.apiKey = data.userKey; // adopt the new account key
    state.secretKey = data.secretKey;
    $("rotateUserKey").textContent = data.userKey;
    $("rotateSecretKey").textContent = data.secretKey;
    $("rotateBox").classList.remove("hide");
    toast("Keys rotated - save them");
  } catch (err) {
    toast(err.message || "Couldn't rotate");
  } finally {
    btn.disabled = false;
  }
});
$("regBtn")?.addEventListener("click", async () => {
  const email = $("regEmail").value.trim();
  if (!email) return toast("Enter an email");
  try {
    const data = await api("/api/v1/me/register", {
      method: "POST",
      body: {
        email,
        firstName: $("regFirst").value.trim(),
        lastName: $("regLast").value.trim(),
      },
    });
    pendingClaim = data.claimId;
    $("acctRegisterVerify").classList.remove("hide");
    if (data.code) {
      // Local development only: filling the field would make verification a formality.
      toast(`Local dev code: ${data.code}`);
    } else {
      toast(data.message || "Check your inbox for a code");
    }
  } catch (err) {
    toast(err.message || "Couldn't send code");
  }
});

$("regVerifyBtn")?.addEventListener("click", async () => {
  const code = $("regCode").value.trim();
  if (!code || !pendingClaim) return toast("Enter the code");
  try {
    await api("/api/v1/me/register/verify", {
      method: "POST",
      body: { claimId: pendingClaim, code },
    });
    toast("Registered - this account is now yours");
    loadAccount();
  } catch (err) {
    toast(err.message || "Invalid code");
  }
});

function companyInfo() {
  return {
    companyName: $("companyName")?.value.trim() || undefined,
    vatNumber: $("companyVat")?.value.trim() || undefined,
    country: $("companyCountry")?.value.trim() || undefined,
  };
}
function renderTopupSummary(inv) {
  const box = $("topupSummary");
  if (!box || !inv) return;
  box.innerHTML =
    kvRow("Net", `€${inv.net.toFixed(2)}`) +
    kvRow("VAT", inv.reverseCharge ? "€0.00 (reverse charge)" : `€${inv.vat.toFixed(2)}`) +
    kvRow("Total", `<strong>€${inv.total.toFixed(2)}</strong>`);
}

$("topupBtn")?.addEventListener("click", async () => {
  if (!window.confirm("Buy 10,000 requests for €50 excl. VAT?")) return;
  try {
    const data = await api("/api/v1/me/tokens", { method: "POST", body: companyInfo() });
    renderTopupSummary(data.invoice);
    toast(`Added ${data.added} requests`);
    loadAccount();
    // Unlock any request that was recorded while the workspace was out of
    // requests - the lock is a live check, so re-reading is what lifts it.
    loadApprovals();
  } catch (err) {
    toast(err.message || "Couldn't top up");
  }
});

/* --------------------------------- boot -------------------------------- */

// The account key lives in the URL (?key=…) so the account is shareable and
// bookmarkable - that is the whole "anonymous, no login" model.
/** Does this key still belong to a live workspace? Network trouble reads as yes. */
async function keyIsLive(key) {
  try {
    const res = await fetch("/api/v1/me", {
      headers: { "x-psh-key": key },
      signal: AbortSignal.timeout(2500),
    });
    // Only a definitive refusal means the key is gone.
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true;
  }
}

async function adoptOfferedWorkspace(offeredKey) {
  try {
    const res = await fetch("/api/v1/me/adopt", {
      method: "POST",
      headers: { "x-psh-key": store.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ key: offeredKey }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    const n = data.requestsMoved || 0;
    toast(
      n
        ? `New agent added to your account - ${n} request${n === 1 ? "" : "s"} waiting here now.`
        : "New agent added to your account - its requests will appear here.",
    );
    // Reload so the new channel (and anything it is already asking) shows up.
    setTimeout(() => location.reload(), 1500);
    return true;
  } catch {
    return false;
  }
}

async function adoptKeyFromUrl() {
  const q = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const raw = q.get("key") || hash.get("key");
  if (!raw) return;
  const key = raw.trim();
  // Remove the key from the URL immediately. It must never sit in the address
  // bar, browser history, or a server/proxy access log.
  const url = new URL(location.href);
  url.searchParams.delete("key");
  url.hash = "";
  history.replaceState({}, "", url.pathname + (url.search || ""));

  const existing = store.apiKey || store.token;
  // The offered key has to work too. Adopting a dead one (a workspace that has
  // been deleted, or a link from an old install) signs the human in and then
  // straight back out when the host rejects it - which reads as "logged out
  // immediately". Better to say so and leave the current session alone.
  if (!(await keyIsLive(key))) {
    toast("That link's account no longer exists - ask your agent for a fresh link.");
    return;
  }
  // Never hijack a live session. Agents open their own account link on every
  // ask, and that must not sign the human into the agent's anonymous account.
  // `?switch=1` switches deliberately.
  if (existing && existing !== key && q.get("switch") !== "1") {
    // A fresh install in another project mints its own anonymous workspace. If
    // that is what this link is, take the agent into the account we are already
    // in: its channel and its pending questions move here, and the agent keeps
    // its key - no warning, no second account, no sign-out.
    if (store.apiKey && (await adoptOfferedWorkspace(key))) return;
    // …but a dead key (workspace deleted, key rotated) must not strand the
    // human on a login gate with no way in. Keep the old session only if it
    // still answers; a paired device (token, no apiKey) always wins.
    if (!store.apiKey || (await keyIsLive(store.apiKey))) {
      toast("This link is for a different account - sign out first to switch.");
      return;
    }
    toast("Your previous session is gone - signing you in with this link.");
  }
  store.apiKey = key;
}
await adoptKeyFromUrl();

// `/login` is the sign-in URL. Anyone already signed in who lands here (a
// bookmark, the back button) belongs in the app.
if (location.pathname === "/login" && store.apiKey) {
  history.replaceState(null, "", "/app");
}

// The gateway's limit message links to `/app#topup`; honour it on arrival.
if (location.hash === "#topup") {
  history.replaceState(null, "", location.pathname + location.search);
  openTopUp();
}
document.addEventListener("click", (e) => {
  if (e.target.closest?.("[data-topup]")) openTopUp();
});

// A reload, a bookmark or a paste lands on #archived directly; nothing above has
// run yet, so the page is chosen once here too.
renderView();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!state.ws || state.ws.readyState > 1) {
    connect();
    return;
  }
  // Back on the page: what is waiting may have been answered in the notch while
  // this tab was in the background, and a missed frame has to be caught up.
  refresh();
});

// Switching back to the window does not change visibility, and the notch sits on
// top of it, so the same catch-up is owed on focus. Debounced: a burst of window
// focus events is one read.
let focusRead = 0;
window.addEventListener("focus", () => {
  if (Date.now() - focusRead < 1500) return;
  focusRead = Date.now();
  if (state.ws && state.ws.readyState === 1) refresh();
});

if (!store.apiKey && !store.token) {
  els.unpaired.classList.remove("hide");
  // No account yet - the sign-in screen keeps just the brand + Docs.
  setSessionChrome(false);
} else {
  connect();
}

// ---- log in / sign up -----------------------------------------------------
// One page: email → (name, only when the account is new) → one-time code.
let authStep = "email"; // email | name | code

/** Reset the auth overlay to the email step. */
function resetAuth() {
  authStep = "email";
  $("authEmailStep")?.classList.remove("hide");
  $("authCodeStep")?.classList.add("hide");
  $("authEmail")?.removeAttribute("disabled");
  $("authNameRow")?.classList.add("hide");
  $("authCodeTools")?.classList.add("hide");
  $("authForm")?.classList.remove("hide");
  $("authUseKey")?.classList.remove("hide");
  $("authBack")?.classList.add("hide");
  $("authKeyRow")?.classList.add("hide");
  if ($("authTitle")) $("authTitle").textContent = "Log in or sign up";
  if ($("authSub")) $("authSub").textContent = "Multiple agents, working side by side.";
  if ($("authSubmit")) $("authSubmit").textContent = "Continue";
  if ($("authHint")) $("authHint").textContent = "We'll email you a 6-digit verification code.";
  if ($("authCode")) $("authCode").value = "";
  codeEmail = "";
  resendAt = 0;
  if ($("authResend")) {
    $("authResend").disabled = false;
    $("authResend").textContent = "Resend code";
  }
}

/**
 * Show or hide the nav chrome that only makes sense with a session. Every path
 * that changes sign-in state goes through here - the boot gate, the socket
 * dropping, and the auth overlay - because when each one toggled its own list
 * they drifted, and the signed-out screen kept the app's buttons and avatar.
 */
function setSessionChrome(signedIn) {
  for (const sel of [".avatar-wrap", ".nav-links", "#newChannelBtn", "#pairQrBtn"]) {
    document.querySelector(sel)?.classList.toggle("hide", !signedIn);
  }
  if (signedIn) return;
  // Nothing below can mean anything without an account behind it.
  $("avatarMenu")?.classList.add("hide");
  $("claimBadge")?.classList.add("hide");
  $("claimBanner")?.classList.add("hide");
  $("appNotices")?.replaceChildren();
  $("navSearchWrap")?.classList.add("hide");
  // Drop the cached avatar too: the next sign-in may be a different account,
  // and a cached colour/initial would flash as that other person.
  try {
    localStorage.removeItem("psh.avatar");
  } catch {
    /* storage disabled */
  }
}

/** Show the auth overlay (used by the "Claim account" badge). */
function showAuth() {
  resetAuth();
  setSessionChrome(false);
  els.paired?.classList.add("hide");
  els.unpaired?.classList.remove("hide");
  $("authEmail")?.focus();
}

/** Seconds before the code can be resent; the server mints a fresh one each time. */
const RESEND_COOLDOWN_MS = 30_000;
let codeEmail = "";
let resendAt = 0;

/** Count down on the resend control so a double click cannot spray codes. */
function startResendCooldown() {
  const btn = $("authResend");
  if (!btn) return;
  resendAt = Date.now() + RESEND_COOLDOWN_MS;
  const tick = () => {
    const left = Math.ceil((resendAt - Date.now()) / 1000);
    if (left > 0) {
      btn.disabled = true;
      btn.textContent = `Resend in ${left}s`;
      setTimeout(tick, 500);
    } else {
      btn.disabled = false;
      btn.textContent = "Resend code";
    }
  };
  tick();
}

async function sendCode(email) {
  codeEmail = email;
  const res = await api("/api/v1/auth/otp", { method: "POST", body: { email } });
  if (res?.devCode) {
    // Local dev: surface the code so it can be copied (never on remote).
    console.log(`[psh.now] dev code: ${res.devCode}`);
    if ($("authDevCode")) $("authDevCode").textContent = res.devCode;
    $("authCodeTools")?.classList.remove("hide");
    $("authCopyCode").dataset.code = res.devCode;
  }
  authStep = "code";
  // The email/name fields are replaced by the code field.
  $("authEmailStep")?.classList.add("hide");
  $("authCodeStep")?.classList.remove("hide");
  if ($("authTitle")) $("authTitle").textContent = "Check your email";
  if ($("authSub")) $("authSub").textContent = `We sent a 6-digit code to ${email}.`;
  if ($("authSubmit")) $("authSubmit").textContent = "Verify";
  if ($("authHint")) $("authHint").textContent = "The code expires in 5 minutes.";
  $("authCode")?.focus();
}

$("authForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("authEmail")?.value.trim() || "";
  if (!email) return;
  const btn = $("authSubmit");
  setBusy(btn);
  try {
    if (authStep === "email") {
      const { exists } = await api("/api/v1/auth/lookup", {
        method: "POST",
        body: { email },
      });
      if (!exists) {
        // New account: ask for a name first, same page.
        authStep = "name";
        $("authNameRow")?.classList.remove("hide");
        if ($("authTitle")) $("authTitle").textContent = "Create account";
        if ($("authSub")) $("authSub").textContent = "Your name, so this account is yours.";
        if ($("authSubmit")) $("authSubmit").textContent = "Create account";
        $("authFirstName")?.focus();
        return;
      }
      await sendCode(email);
      return;
    }
    if (authStep === "name") {
      await sendCode(email);
      return;
    }
    // Code step: better-auth verifies and sets the session cookie.
    const code = $("authCode")?.value.trim() || "";
    if (!code) return;
    const res = await fetch("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        otp: code,
        name: `${$("authFirstName")?.value.trim() || ""} ${$("authLastName")?.value.trim() || ""}`.trim(),
        firstName: $("authFirstName")?.value.trim() || undefined,
        lastName: $("authLastName")?.value.trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error("That code didn't work. Try again.");
    // Link this identity to the psh account and get the key back.
    const linked = await api("/api/v1/auth/connect", {
      method: "POST",
      body: { userKey: store.apiKey || undefined },
    });
    store.apiKey = linked.userKey;
    // The app has one canonical URL now; `/login` is only the way in.
    leaveSignIn();
  } catch (err) {
    toast(err.message || "Something went wrong");
  } finally {
    setBusy(btn, false);
  }
});

$("authCopyCode")?.addEventListener("click", async () => {
  const code = $("authCopyCode").dataset.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast("Code copied");
  } catch {
    toast("Copy failed");
  }
});
$("authResend")?.addEventListener("click", async () => {
  if (!codeEmail || Date.now() < resendAt) return;
  const btn = $("authResend");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await sendCode(codeEmail);
    toast("New code sent");
  } catch (err) {
    toast(err.message || "Couldn't resend the code");
    btn.disabled = false;
    btn.textContent = "Resend code";
  }
});
$("authUseKey")?.addEventListener("click", () => {
  $("authForm")?.classList.add("hide");
  $("authUseKey")?.classList.add("hide");
  $("authBack")?.classList.remove("hide");
  $("authKeyRow")?.classList.remove("hide");
  // Name the state: this *is* the anonymous login - no email, no code.
  if ($("authTitle")) $("authTitle").textContent = "Anonymous login";
  if ($("authSub")) $("authSub").textContent = "Paste the account key your installer printed. No email needed.";
  $("keyInput")?.focus();
});
// Back out of the anonymous login to the email one.
$("authBack")?.addEventListener("click", () => {
  resetAuth();
  $("authEmail")?.focus();
});
$("keyLoginBtn")?.addEventListener("click", () => {
  const key = $("keyInput").value.trim();
  if (!key) return;
  store.apiKey = key; // kept in localStorage only - never in the URL
  leaveSignIn();
});
$("keyInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("keyLoginBtn")?.click();
});
/* --------------------- channel search (above the list) ------------------ */
/** The live filter sitting above the first channel. */
function channelQuery() {
  return ($("channelSearch")?.value ?? "").trim().toLowerCase();
}

function clearChannelSearch(focus = false) {
  const input = $("channelSearch");
  if (!input) return;
  input.value = "";
  $("channelSearchClear")?.classList.add("hide");
  renderChannels();
  if (focus) input.focus();
}

/**
 * Open (expand) or close a channel row, the same state the chevron toggles.
 *
 * Only the card in hand is touched. A full re-render used to rebuild every card
 * (colour pickers included) and re-request every open history, which is why the
 * chevron used to sit there while the list caught up. When the card is not in the
 * DOM - it was filtered out of view - the list is redrawn so the state still
 * applies when it comes back.
 */
function toggleChannelOpen(id) {
  const open = !(state.channelHistOpen[id] ?? false);
  state.channelHistOpen[id] = open;
  const card = document.querySelector(`.channel-card[data-id="${CSS.escape(id)}"]`);
  if (!card) {
    renderChannels();
    return;
  }
  card.querySelector(`#hist-${CSS.escape(id)}`)?.classList.toggle("hide", !open);
  const btn = card.querySelector("[data-hist]");
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", `${open ? "Hide" : "Show"} request history`);
  }
  if (open) void loadHistory(id);
}

/* ------------------------------- archive ------------------------------- */

/**
 * `#archived` is the archive page: the app with the requests and the guides taken
 * out. A hash rather than a second document, so it costs no bundle, keeps the
 * signed-in state and the live socket, and Back returns to the list as it was.
 */
function archiveView() {
  return location.hash === "#archived";
}

/** Show the page the address asks for. */
function renderView() {
  const signedIn = !!(store.apiKey || store.token);
  const archived = signedIn && archiveView();
  document.body.classList.toggle("view-archive", archived);
  if (archived) void loadArchived();
}

async function loadArchived() {
  const list = document.getElementById("archivedList");
  if (!list) return;
  list.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    const { connections } = await api("/api/v1/channels?archived=1");
    list.innerHTML = connections.length
      ? connections.map(archivedRow).join("")
      : `<div class="arch-empty">Nothing archived. A channel you archive from its menu shows up here.</div>`;
    wireArchived();
  } catch (err) {
    list.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
  }
}

function archivedRow(c) {
  return `
    <div class="arch-row">
      <span class="arch-dot" style="background:${esc(c.color || "#6c8cff")}" aria-hidden="true"></span>
      <span class="arch-name">${esc(c.name)}</span>
      <span class="arch-when">${c.archivedAt ? esc(relTime(c.archivedAt)) : ""}</span>
      <button class="btn pill sm" data-restore="${esc(c.id)}">Restore</button>
      <button class="btn pill sm danger-ghost" data-purge="${esc(c.id)}">Delete</button>
    </div>`;
}

function wireArchived() {
  const list = document.getElementById("archivedList");
  if (!list) return;
  for (const btn of list.querySelectorAll("[data-restore]")) {
    btn.onclick = () => restoreChannel(btn.dataset.restore, btn);
  }
  for (const btn of list.querySelectorAll("[data-purge]")) {
    btn.onclick = () => purgeChannel(btn.dataset.purge, btn);
  }
}

/** Put a channel back on the home page, with its requests and its keys intact. */
async function restoreChannel(channelId, btn) {
  btn.disabled = true;
  try {
    await api(`/api/v1/channels/${channelId}/archive`, {
      method: "POST",
      body: { archived: false },
    });
    toast("Channel restored");
    await Promise.all([loadArchived(), loadConnectionsList()]);
  } catch (err) {
    btn.disabled = false;
    toast(err.message || "Couldn't restore");
  }
}

/**
 * The one destructive press in the app, and it says what it costs: the channel
 * and the requests in it. Archived first, so it is always a second thought.
 */
async function purgeChannel(channelId, btn) {
  const name = btn.closest(".arch-row")?.querySelector(".arch-name")?.textContent?.trim();
  if (
    !window.confirm(
      `Delete “${name || "this channel"}” for good? Its requests are deleted with it, and this cannot be undone.`,
    )
  )
    return;
  btn.disabled = true;
  try {
    await api(`/api/v1/channels/${channelId}`, { method: "DELETE" });
    toast("Channel deleted");
    void loadArchived();
    void loadConnectionsList();
  } catch (err) {
    btn.disabled = false;
    toast(err.message || "Couldn't delete");
  }
}

window.addEventListener("hashchange", renderView);

$("channelSearch")?.addEventListener("input", () => {
  const input = $("channelSearch");
  $("channelSearchClear")?.classList.toggle("hide", !input.value);
  renderChannels();
});
$("channelSearchClear")?.addEventListener("click", () => clearChannelSearch(true));
$("channelSearch")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("channelSearch").value) {
    e.stopPropagation();
    clearChannelSearch(true);
  }
});

// Surface runtime errors instead of failing silently.
window.addEventListener("error", (e) => toast(`Error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  toast(`Error: ${e.reason?.message || e.reason}`),
);
