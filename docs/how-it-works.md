# How psh.now works: the full flow

Everything lives in one repo: **this repository**
→ `https://psh.now` (public host, Cloudflare Tunnel).

This doc follows the whole loop: **install → mint → ask → approve → the agent
continues.**

---

## 0. The pieces

| Piece | Full path / URL |
|---|---|
| Repo (everything) | this repository |
| Canonical skill | `skills/psh-now/` |
| Publishable skill | `the published skill repo` |
| Install guide (served) | `https://psh.now/setup.md` |
| Hosted skill (served) | `https://psh.now/skill.md` |
| Installer (served) | `https://psh.now/install.sh` |
| Installed skill (agent) | `~/.agents/skills/psh-now/` |
| Credentials (agent) | `<project>/.psh/keys.json` (machine fallback: `~/.psh/keys.json`) |
| Dashboard | `https://psh.now/app` |
| Server | `src/index.ts` (Bun, `:4321`) |
| Database | `postgres://svl@localhost:5432/pshy` |

---

## 1. Install flow (what the agent does)

```
human                          agent                              host
─────                          ─────                              ────
"I want to install psh.now.
 Please start by reading the
 instructions at
 …/setup.md and follow them
 for a quick install."   ───►  curl …/setup.md
                               curl …/install.sh        ───►  serves the guide
                               (inspects them, good)         and installer
                               curl …/install.sh | sh   ───►  installs the skill
                                                              into
                                                              ~/.agents/skills/psh-now
                                                              and runs setup.sh
                               curl …/api/v1/health     ───►  {"ok":true}
                          ◄─── "installed ✓, health ✓,
                                account key, track / claim /
                                connect links"
```

**The install guide** (`/setup.md`) is the single source of truth. It says:

1. The goal is **machine-wide**, the skill every folder sees, `psh` on PATH, one account
   record. With the private repo (npm + git + GitHub credentials):
   `npx skills add passy-ai/psh-now-skill -g -y`, then
   `sh ~/.agents/skills/psh-now/scripts/setup.sh`, the `-g` copy is what the second line runs.
   Without credentials: `curl -fsSL https://psh.now/install.sh | sh` (it verifies every file
   against `/.well-known/agent-skills/files.json` and mints the keys too).
2. `curl -fsS https://psh.now/api/v1/health`, `{"ok":true}`.
3. Report the account key and the three links.
4. If the sandbox refused the machine-wide writes, setup.sh's last line says
   `psh_machine_wide=incomplete`: say so, send **one** ask through psh.now, re-run on approval
   (`docs/install-contract.md`).

Measured: **6 turns, ~40s** (pi + opencode-go `deepseek-v4.1-flash`).

---

## 2. Mint flow (setup.sh)

`skills/psh-now/scripts/setup.sh`:

```
POST https://psh.now/api/v1/mint
  → { userKey, channelKey, workspaceId,
      accessUrl, claimUrl, channelUrl }

writes, per project (all mode 0600):
  <project>/.psh/keys.json    ← userKey + channelKey + links
  <project>/.psh/host         ← the host
  <project>/.psh/config.json  ← the CLI's config
  <project>/.psh/README.md    ← what this is, skill path, keys, next command
and on the first install on a machine:
  ~/.psh/keys.json            ← that machine's account (later projects adopt it)
  ~/.agents/skills/psh-now/   ← machine-wide skill copy + a `psh` command on PATH
```

| Key | What it is | Who holds it |
|---|---|---|
| `userKey` | the **account key**, the login, and the identity while anonymous | the human |
| `channelKey` | what the **agent** sends (`x-psh-key`) | the agent |

---

## 3. Ask flow (the actual product)

```
agent (any harness)                 host                      human
───────────────────                 ────                      ─────
POST https://psh.now
  x-psh-key: <channelKey>
  { title, message, channel }  ───► creates a request
                                     (status: pending)
                                     broadcasts over WS
                                     ────────────────────►  appears under
                                                            Open Channels
                                                              [Deny] [Approve]
                                     ◄────────────────────  taps Approve
                                     records the decision
                                     (audit_log + NOTIFY)
  ◄───────────────────────────────  { "approved": true }
agent continues
```

- The agent proceeds **only** on literal `approved: true`. Timeout, error, or
  pending = do not act. **Silence is never consent.**
- Blocking call: default 90s. Async: `{"wait":false}` → `pollUrl`, answerable 24h.
- One approval costs **2 requests** (inbound + outbound).

### The channel
A request carries a channel (`channel` / `channelName`, aliased to
`connection`/`session`). The dashboard groups requests by channel, and a channel
can be shared with another account.

---

## 4. Approve flow (the human side)

1. Open **`https://psh.now/app?key=<userKey>`**, the key is in the
   URL, so no sign-in step.
2. The **account card** shows your name (or the anon key) + Anonymous/Free badge.
3. **Open Channels** lists pending requests: `Request · Description · Received ·
   Action` with **Approve / Deny**.
4. **Claim** a username at `/claim?key=<userKey>` (first/last/email → emailed code).
5. **Connect another agent** with the channel's reusable link (`/c/<channel>`), the
   channel card's **Copy prompt for agent** button hands it over, instructions included.

---

## 5. Keys, channels, sharing

| Concept | Where |
|---|---|
| Account | `tenants` table (plan, email, name, tokenBalance) |
| Channel | `sessions` table (`name`, `description`, `archived_at`) |
| Channel key | `api_keys` (`scope: ask`, optional `session_id`) |
| Sharing | `channel_shares` (`channel_id`, `owner_id`, `shared_with`) |
| Email invites | `channel_invites` (`channel_id`, `email`, token) |
| Join links | `join_tokens` |
| Devices | `devices` + `pairing_tokens` |

**Scopes:** `ask` keys (agents, channel keys, join links) can create/read their own
approvals but get **403** on decisions, keys, devices, profile, tokens, and are
refused on the dashboard WebSocket. The account key and paired devices are `manage`.

---

## 6. The endpoints (one host)

```
POST /                          create an approval (the one call)
POST /api/v1/approvals          same, canonical
GET  /api/v1/approvals/:id      fetch ( ?wait=<s> long-poll )
POST /api/v1/approvals/:id/decision   approve / deny
GET  /api/v1/channels           list (owned + shared, with key/member counts)
PATCH /api/v1/channels/:id      title / description
POST /api/v1/channels/:id/archive
GET/POST /api/v1/channels/:id/keys    channel keys
GET  /api/v1/channels/:id/members     owner + approvers + invites
POST /api/v1/channels/:id/invites     invite a registered account by email
GET/POST /api/v1/me/keys        account keys
POST /api/v1/me/register        claim (name + email → code)
POST /api/v1/me/join-links      one-time "connect another agent" link
GET  /api/v1/me                 account + usage
GET  /api/v1/health             {"ok":true}
WS   /ws?token=…                dashboard / device stream
GET  /setup.md /skill.md /docs /install.sh /openapi.json /claim /j/:token
```

---

## 7. Run it locally

```bash
cd psh-now
bun src/index.ts                        # server on :4321
# put any TLS terminator in front of it, or follow docs/self-hosting.md
```

The tunnel's ziti/edge session can expire while the process stays up (→ 502);
the keepalive probes `/api/v1/health` and restarts it.

---

## 8. One-line summary of each step

| Step | Command / path |
|---|---|
| Read the guide | `curl https://psh.now/setup.md` |
| Install | `curl -fsSL https://psh.now/install.sh \| bash` |
| Skill lands at | `~/.agents/skills/psh-now/` |
| Also installs | machine-wide skill copy + a `psh` command on PATH |
| Keys land at | `<project>/.psh/keys.json` (0600) |
| Agent asks | `POST https://psh.now` with `x-psh-key` |
| Human approves | `https://psh.now/app?key=<userKey>` |
| Answer | `{"approved":true}` / `{"approved":false}` |
