# Prompt templates - single source of truth

All prompts pasted into agents live here. App UI, docs, and skills **must** match
these templates.

`<host>` = `https://psh.now`

---

## Templates

Three, and nothing else. Each one reaches a human inside a single fenced block so they can
copy just that, and none of them contains an environment variable: the channel link travels
as an argument, or as plain words, never as `PSH_JOIN=`.

### 1. Install

```text
I'd like you to set up psh.now: Install as a skill with npx skills add passy-ai/psh-now-skill -g -y

If not, do this instead: curl -fsSL https://psh.now/install.sh

After installing, send me a test request.
```

The landing page, the first snippet on `/docs`, and `/setup.md`. It ends by asking for a test
request, because a fresh install should prove itself.

The `skills add` line carries `-y` on purpose: without it the CLI waits on a prompt that a
harness cannot answer, and installs nothing. It copies the skill machine-wide and mints
nothing, so `scripts/setup.sh` still runs once after it. The `curl` line below installs and
mints in one go.

### 2. Join a channel

```text
I'd like you to use psh.now and join this channel: https://psh.now/c/<channel-id>
```

The agent is already set up. This is what the dashboard's **Copy prompt for agent** produces, and
it is the only prompt the `/c/<channel>` page and `/join.html` offer. The link is the whole instruction:
redeeming it creates a channel key on the **existing** account and mints nothing new.

An installed agent reads it as: run `sh ~/.agents/skills/psh-now/scripts/setup.sh <link>`,
then carry on. A channel link in a message always means join; it never means set up a new
channel.

### 3. New sandbox that must join

```text
I'd like you to set up psh.now: Install as a skill with npx skills add passy-ai/psh-now-skill -g -y
and join https://psh.now/c/<channel-id>

If not, do this instead: curl -fsSL https://psh.now/install.sh
```

For a container or a fresh machine with no user present, which must join while it installs. The
link is named once, in the sentence the agent reads, and the fallback stays a plain install: the
installer is never handed the link as an argument, because re-running it is what re-installs a
machine that only needed to join. **This prompt appears in the docs and nowhere else.**

### 4. The one prompt the install report prints

The report's `{connect_prompt}` is the literal text of §2, character for character. It used to
be a second copy here, which is how the two drifted apart; the literal lives in §2 and this
section only records where it is used.

> **Measured, 2026-10-17.** Handing an agent the prose version ("open that link first; it is
> this channel's instructions") sent a real pi agent to `/setup.md`, where it ran the plain
> installer and minted a throwaway account moments before redeeming the link (workspace
> `Z6o33M93RJe`). A prose prompt is the shape that fails; the link plus the exact command is
> the shape that works.

### 5. Agent approver loop

Configures an agent to approve requests from other agents.

```text
I would like you to approve psh.now requests.
If psh.now isn't installed yet, read https://psh.now/setup.md and install it first. Then read https://psh.now/docs/agent-to-agent.md and start the approver loop.
```

### 6. Confirm the connection (optional, only when testing)

Not part of installing or connecting. This is the same sentence §1 ends with; use it on its
own when you want to watch one request travel end to end.

```text
Send me one test question through psh.now so I can confirm it works.
```

---

## Direct Commands Reference

| Command | Purpose |
| --- | --- |
| `scripts/setup.sh` | Mint new account + keys |
| `scripts/setup.sh <link>` | Join the channel in that `/c/<channel>` link (the prompt form) |
| `scripts/setup.sh --join <link>` | The same join, spelled out |
| `scripts/setup.sh --uninstall` | Remove the skill, the `psh` command and symlinks (keys stay) |
| `psh` / `psh doctor` | Where everything is / end-to-end health |
| `scripts/ask.sh "<title>" "<message>" [channel]` | Submit request and await human approval |
| `PSH_NO_OPEN=1 scripts/ask.sh …` | Submit request without opening browser (headless) |


## The install commands the guides ship

Two, in this order, and the second one always works - it needs neither npm, nor git, nor GitHub
credentials:

| path | commands | needs |
| --- | --- | --- |
| package (primary) | `npx skills add passy-ai/psh-now-skill -g -y` (copies the skill machine-wide; `scripts/setup.sh <link>` joins) | npm + git + GitHub credentials (the human's machine, or CI with a token) |
| fallback | `curl -fsSL <host>/install.sh \| bash` | nothing - no npm, no git, no credentials |

The package route carries `-g`: it installs machine-wide - the skill every project sees, `psh` on
PATH, `~/.psh/keys.json` - which needs writes outside the workspace and is the goal. The fallback
line writes inside the folder only, needs no permission, and is the project-local copy; it is
finished with one ask through psh.now (see `docs/install-contract.md`). `-a universal` is the
`.agents/skills` location this product and the harnesses use; without it the CLI also fans out to
~60 other agent directories in the project (harmless, noisy). The **connect** prompts (§3, §4) keep
the curl line: it installs *and* joins/mints in one step and needs no credentials, which is exactly
what a pasted prompt has to guarantee.

The machine-wide copy - the skill for every project, `psh` on PATH and `~/.psh/keys.json` - stays
the human's own line `curl -fsSL <host>/install.sh | sh`. `npx … -g` alone installs only the skill:
it leaves no `psh` on PATH and no machine record, so it does not replace that line.

Measured, in a container, 2026-10-17: a fresh box with **no** credentials fails the package install
(`Failed to clone repository … spawn git ENOENT` without git; `Failed to clone` with git but no
credential helper, `GITHUB_TOKEN` set or not - it clones, it does not use the API tarball). With
`git config --global credential.helper store` plus a `~/.git-credentials` token line it installs and
mints cleanly, and so does `curl … | sh` with no credentials at all. Keep the repo therefore
scoped to machines that already have credentials, or make it public before it is the only path.

## Where each template is produced today

Checked against the code and the live site on 2026-10-17. Three claims in the earlier
version of this table were wrong - that is how the landing page drifted into being a
third variant of §1 without anyone noticing.

| Template | Producer |
|---|---|
| §1 | **landing page → "Copy instructions"** (`PROMPT` in `website/app.js`); the **first snippet on `public/docs.html`**; `/setup.md` (`setupGuide()` in `src/routes/discovery.ts`); `docs/install-prompt.md` |
| §2 | channel card → **Copy prompt for agent** (`channelPrompt()` in `public/app.js`); the `/c/<channel>` page; `public/join.html`; the install report (`{connect_prompt}` in `skills/psh-now/report.txt`, filled by `setup.sh`) |
| §3 | `public/docs.html` → **Sandbox / no browser** (`#sandbox`). The `/c/<channel>` URL in §2 is fetched by an **agent**: that page `/c/<channel>` URL in this prompt is fetched by an **agent**: it answers text (plain, or markdown if `Accept: text/markdown`) and only serves `join.html` to a real browser navigation - `Sec-Fetch-Dest: document`. Never key that split on `Accept` alone: agent fetch tools send browser-like Accept headers, and `join.html`'s command is injected by client-side JS |
| §4 | nothing of its own: the report prints §2 character for character. There is no "Connections → agent key copy" producer in `public/app.js` (no `PSH_API_KEY` string in the bundle), and the *agent-facing* surfaces (`/setup.md`, `/docs` as markdown, `/llms-full.txt`) still never mention `PSH_API_KEY` - the key reaches an agent through the report or through this docs section, which is why the block has to be copy-ready |
| §5 | `docs/agent-to-agent-approval.md` |
| §6 | `docs/test-it-yourself.md` - hand-written, not shown in the UI |

Every prompt above reaches a human inside a single code block, with no `PSH_*` variable in it,
and every prompt ends without an em dash (the house style is a plain hyphen). Guarded by two
checks, because text drifts silently:

```bash
bun .verify/website-prompt-check.mjs     # the landing page: clicks the real button, reads the clipboard (7)
bun .verify/prompt-wording-check.mjs <key> <channel-url>   # the dashboard card + the /c/ page
```
