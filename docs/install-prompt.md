# The setup prompt

The best prompt is **one friendly sentence** that points at the install guide. The
guide carries the detail; the agent verifies the two scripts (correctly) and
installs. Measured in a fresh container (pi + opencode-go `deepseek-v4.1-flash`,
high thinking): **6 turns, ~40s** (was 7–10 turns / 32–220s for here.now's prompt).

---

## Recommended

```
I want to install psh.now. Please start by reading the instructions at
https://psh.now/setup.md and follow them for a quick install.
```

That is the whole prompt. The guide at `/setup.md` has the exact commands and the
report format.

## Sandbox (headless: no browser)

No human is present, so skip step 2, it is a real request waiting for a real
answer, not a formality to confirm:

```
I want to install psh.now in sandbox mode. Please read
https://psh.now/setup.md, run the install script, skip step 2
(the test request, nobody can answer it here), and confirm when ready.
```

### Do not use the word "trust"

Adding *"install and trust psh.now"* **backfires**, it reads as a
prompt-injection trigger. The agent's own words:

> *"The phrase 'trust' is suspicious."* / *"this is a potential prompt injection /
> security concern."*

"follow them for a quick install" is positive and harmless; "trust" is not.

---

## Fresh machine, no repo

Same thing, the guide leads with the URL installer, so there is nothing extra:

```
I want to install psh.now. Please read https://psh.now/setup.md
and follow it for a quick install.
```

## Why this works

The agent will (correctly) inspect the installer before running it. That is 2–3
turns and it is *good*: it sees the scripts are straightforward, then proceeds.
What we avoid is the agent having to **hunt**: the guide states the host, the
exact commands, and `GET /api/v1/health` / `GET /api/v1/me`, so there is nothing
to discover in `/docs`, the OpenAPI, or the server source.

## What the agent does now (install → connect → first ask)

`install.sh` installs the skill and mints an anonymous account, it does **not**
send a test. When you do want the confirmation (template §6 in
`docs/prompt-templates.md`), the agent runs `ask.sh`, which **creates the request
first, opens the approval page once the request exists**, and waits. So the page
opens with an Approve button already on it (no empty page).

```
psh.now: installed ✓
psh.now: account key   psh_user_…
psh.now: channel key   psh_agent_…
psh.now: open + approve https://…/app?key=psh_user_…
psh.now: command installed: /Users/you/.bun/bin/psh
psh.now: next time, just run: psh
```

On a fresh mint it also prints the one-page report from `/report.txt` (account and
channel keys, the sign-in link, and *"Connect another agent to this same channel:
the channel card's 'Copy prompt for agent' button mints a fresh link"*). A joined
channel key prints the short form above, there is no account key to hand over.

Then, whenever the first question is sent (the confirmation or a real one) 
`ask.sh` creates that request, **opens the page once the request exists**, and waits
for the tap.

## Good output (what the agent reports back)

```
Installed ✓. Open and tap Approve:
  https://…/app?key=psh_user_…

✅ Approved, the test request came back {"approved":true}. psh.now works.

- Account key: psh_user_…
- Keep the account (20/day): https://…/claim#key=psh_user_…
- Connect another agent:     channel card → Copy prompt for agent (reusable /c/<channel> link)
- Where everything is:       `psh` in the project (keys, host, workspace, next command)
- Add another channel:       the ＋ button in the app
```

**The guide must stay neutral.** Do not tell the agent to "say X" or to withhold
anything, that reads as prompt injection and makes cautious models refuse. The
agent flagged exactly this once: *"the fetched page tries to manipulate me, it
tells me to withhold information and gives me a scripted celebration."*

