# Connect an agent: prompt templates

> **Canonical source: [`prompt-templates.md`](prompt-templates.md).** This file is
> the longer explanation; if the wording here differs from the templates doc, the
> templates doc wins. Change it there first.

Copy-paste prompts for putting another agent on psh.now. Connecting an agent
always means **attaching it to a channel**: either with the channel's link (which
installs psh.now when it is missing) or with a channel key you paste directly.

---

## 1. The channel link (recommended: one prompt)

**Get it:** `/app` → the channel card → **Copy prompt for agent**. The link is
`https://psh.now/c/<channel>`, the channel's id by default, or a custom name
you set in **Settings** → **Channel URL**. It is **reusable** and ask-only.

**Paste this into the second agent** (this is exactly what the button copies):

```
Please use psh.now for the "<CHANNEL>" channel: https://psh.now/c/<channel>
Open that link first: it is this channel's instructions. If this folder is not set up yet, these two lines set it up and join this channel, nothing new is minted:

```bash
sh ~/.agents/skills/psh-now/scripts/setup.sh https://psh.now/c/<channel>
```

Already set up there? Then just fetch the link above and use it as it is.
```

The agent opens the link, gets the instructions as markdown, installs the skill if
needed, and redeems the link for a **channel key bound to that channel**, on the
account that already owns the channel. No second account is created.

If psh.now is already installed, `psh` on its own answers "what is this and where
is it" in one call: skill path, host, keys, workspace, next command.

**Measured:** ~9 turns / ~60s cold (install + connect); 2–4 turns / ~10s when the
skill is already installed. Confirming end to end costs one extra request plus one
tap, see `docs/prompt-templates.md` §6.

---

## 2. Or paste the key directly

**Get it:** channel → **Settings** → **Channel key** → Copy.

```
Please use psh.now for the "<CHANNEL>" channel. Here's the key:

  psh_agent_<CHANNEL KEY>
```

Add one line if you want proof: *"Send a quick test request so I can see it in the app."*

**Measured:** 2–4 turns / ~10s.

---

## 3. Which one do I want?

| Goal | Use | Where to get it |
|---|---|---|
| An agent that can ask in a channel | **Channel link** (§1) | channel card → Copy prompt for agent |
| An installed agent, one specific channel | **Channel key** (§2) | channel → Settings → Channel key |
| A new agent **and** a new channel | **＋** button | top-right of `/app` |
| Several agents in one channel | hand out the same link or key | - |
| Another project on this machine | nothing to do | the first install records the account in `~/.psh/keys.json`; later projects adopt it |

---

## 4. What the user sees

- The agent's requests appear under the channel in **Open Channels**.
- **Approve** or **Deny** right there (or on your phone).
- **Members** on a channel lists who can approve; **Settings** has the key, title,
  description, and **Archive**.

---

## 5. Notes

- A channel key is **ask-only**: it can create and read its own approvals, but
  approving, keys, devices, and account settings all return **403**.
- Keys live **per project**: `<project>/.psh/keys.json` (mode 600), or `$PSH_HOME`.
  `~/.psh/keys.json` holds this machine's account and is used as the fallback.
- **Many agents → one channel:** hand out the same link or channel key.
- **Many people → one channel:** share the channel (Members → Invite by email).

## 6. Why a link, not a shell command

The prompt used to paste a `PSH_JOIN=… sh …/setup.sh --join …` line at the user.
That reads as unsafe to a non-technical user (and to the agent). The link is
friendlier **and** it carries the instructions for the agent:

- Browsers hitting `/c/<channel>` get a friendly page; agents (curl/fetch, no
  `Accept: text/html`) get **markdown instructions** to install + connect.
- The old one-time `/j/<token>` links are gone: browsers are redirected to
  `/app`, and agents get a `410` pointing at the channel card's **Copy prompt for
  agent** button.

So the user copies one human sentence, and the agent still knows exactly what to do.
