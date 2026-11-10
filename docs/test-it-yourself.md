# Test it yourself

A manual test plan you can run in a fresh folder. Everything is live at
**https://psh.now**; the local server is on `:4321` and the tunnel
is up. The database is currently empty (0 accounts), so you start clean.

**Absolute path to this file:**
`docs/test-it-yourself.md`

---

## 0. Before you start (10 seconds)

```bash
curl -s -o /dev/null -w "local %{http_code}\n"  http://localhost:4321/api/v1/health
curl -s -o /dev/null -w "public %{http_code}\n" https://psh.now/api/v1/health
```

Both should say `200`. If the public one says `502`, the Cloudflare Tunnel's
session expired, restart it:

```bash
cd psh-now && bun src/index.ts
```

---

## 1. Install in a fresh folder

```bash
mkdir -p ~/Projects/psh-test && cd ~/Projects/psh-test
```

Open a new agent session and paste:

```
I want to install psh.now. Please start by reading the instructions at
https://psh.now/setup.md and follow them for a quick install.
```

**Expect** (~35s):
- The agent reads `/setup.md`, inspects the installer, runs it, and reports the keys.
- It installs and stops there: the confirmation is step 2 of the guide, and it only
  runs when you ask for it. This is a test, so ask, *“send me one test question
  through psh.now”* (template §6).

**Check:**
- [ ] The skill landed at `~/.agents/skills/psh-now`, a `psh` command is on PATH
      (`command -v psh`), and `<project>/.psh/keys.json` exists.
- [ ] Asked to confirm, it sent a real question through psh.now and waited for you.

---

## 2. Answer it (that IS the test)

The agent shows a link like `https://psh.now/app?key=psh_user_…`.
Open it and tap **Approve**. **That's the whole product in one tap**, and you did
it while the install command was still running.

**Expect:**
- [ ] The agent says it was confirmed and tells you what to do next.
- [ ] The request moves out of pending (channel → **History**).

**Expect:**
- [ ] **Account card** at the top: the **anon key as the handle** (monospace),
      an **Anonymous** badge, and a **Claim a username** button.
- [ ] **ACCOUNT KEY** row: `psh_user_…` with the middle **blurred**, an **eye**
      to reveal/hide, and a **copy** icon.
- [ ] **CONNECT ANOTHER AGENT** row with a link icon + a one-time join URL.
- [ ] **Devices** and **Billing & Top-up** chevrons below.
- [ ] No channels yet → *"No channels yet. An agent's first request creates one."*

**Try:**
- [ ] Tap the **eye** (the key un-blurs. Tap again) re-blurs.
- [ ] Tap **copy**, the key is on your clipboard.
- [ ] Add the page to your phone's home screen (it's a PWA).

---

## 3. The app itself + claim a username

You're already in the app from the approve link.

**The account card (top):**
- [ ] The **anon key as the handle** (monospace) + an **Anonymous** badge.
- [ ] **ACCOUNT KEY** row: middle **blurred**, an **eye** to reveal/hide, a **copy** icon.
- [ ] **CONNECT ANOTHER AGENT** row with a link icon + a one-time join URL.
- [ ] **Devices** and **Billing & Top-up** chevrons below.
- [ ] The channel from the test request (named `Default`, or after your project).

**Try:**
- [ ] Tap the **eye** (the key un-blurs. Tap again) re-blurs.
- [ ] Tap **copy**, the key is on your clipboard.
- [ ] Add the page to your phone's home screen (it's a PWA).

**Claim a username:** tap **Claim a username**.
- [ ] A form: **Handle** (with a live available/taken check), **First name**,
      **Last name**, **Email**.
- [ ] Type a handle → it says **available** or **taken** within a moment.
- [ ] Fill it in → **Email me a code** → a code appears (dev mode) → **Verify & claim**.
- [ ] The header becomes **@yourhandle** with a **Free** badge.
- [ ] You can't set a handle without registering (the form is the only path).

---

## 4. Connect a second agent to a channel

**Option A, channel key (recommended).**
In the app: tap **＋** (top right) → name it e.g. `Research Agent` → **Create**.
It prints a prompt. Copy it.

Open a **second** agent session and paste that prompt. **Expect** in ~10s:
- [ ] The agent says it is connected and ready, the prompt itself asks for no test.
- [ ] Ask it for one: *"Send me a test request through psh.now"* → the request
      appears in the app under **Research Agent**.

**Option B, join link.**
In the app: **Connect another agent** → **Copy link** → paste into a second agent
with *"install the skill if needed, then join."* It gets an **ask-only** key on the
**same account**, it can ask, never approve.

**Check:**
- [ ] A second agent's requests show up on **your** account, in the right channel.
- [ ] The channel header shows `N pending` and `N keys · M members`.

---

## 5. The actual loop (the whole point)

In the first agent session, ask it something that forces a question, e.g.:

```
create a plan for this folder
```

**Expect:**
- [ ] Instead of stopping in the terminal, the agent routes a yes/no to psh.now.
- [ ] The request appears under **Open Channels** (if your tab is open, live).
- [ ] You tap **Approve** → the agent continues.
- [ ] Or **Deny** → the agent stops and summarises.

**Check:**
- [ ] After deciding, the request moves out of pending (open **History** on the
      channel to see it).
- [ ] The agent proceeded **only** on `approved: true` (deny/timeout = no action).

---

## 6. Channel Settings

In the app, open the channel → **Settings**.

**Check:**
- [ ] **Title** and **Description** are editable; **Save changes** updates the
      channel header.
- [ ] **Channel key** is listed with a **copy** icon; **New key** creates one.
- [ ] **Archive channel** hides it from the list (it moves to **Channels ▾**).

---

## 7. Members & sharing

Open the channel → **Members**.

**Check:**
- [ ] It lists the owner (you).
- [ ] **Invite someone** → by `@handle` or email.
- [ ] Inviting an email with no account returns an **invite link** (copied), open
      it in a private window and accept it after signing in.

---

## 8. Devices

**Devices ▾** → **Generate pairing code**.

**Check:**
- [ ] A QR + URL appear (hidden until you ask).
- [ ] Opening the URL on a phone → **Pair this device** → you land back in the app.

---

## 9. Billing & Top-up

**Billing & Top-up ▾**.

**Check:**
- [ ] Shows plan + requests used + token balance.
- [ ] **Company details** chevron (name / VAT / country).
- [ ] **Buy 10,000 requests** adds the package and shows an invoice summary; with a
      VAT number it's **reverse charge** (0% VAT).

---

## 10. Edge cases worth poking

- [ ] **Wrong key:** open `/app?key=psh_user_bogus` → it should not sign you in.
- [ ] **Expired/again:** reuse the join link → should fail (one-time).
- [ ] **No device:** ask an agent while no phone is paired → it times out and the
      agent does **not** act.
- [ ] **Plan limit:** an anon account is capped at 20 requests total → the 21st
      returns `402 plan_limit` with a `paymentUrl`.
- [ ] **Two agents, one channel:** send the same channel key to two agents → both
      land in the same channel.
- [ ] **`/setup` is gone:** `curl -s -o /dev/null -w "%{http_code}" https://psh.now/setup` → **404**.

---

## 11. Things to look at while you're in there

- [ ] Does every page look like the same product? (`/app`, `/claim`, `/c/<channel>`,
      `/invite/<token>`, `/@handle`, `/pair/<token>`; a dead `/j/<token>` redirects
      browsers to `/app` and answers agents with `410`)
- [ ] Phone width (390px): does the request table stack cleanly?
- [ ] Is the first-run experience clear? (Arrive with a claim link and no channels,
      do you know what to do?)
- [ ] Anything that reads like AI-generated filler?

---

## 12. If something breaks

- **502 on the public host** → the tunnel or proxy in front of the server is down, not psh.now.
- **Agent asks in the terminal instead of psh.now** → note the session id and tell
  me; the skill wording may need a nudge.
- **`psh doctor` says no config** → run
  `sh .agents/skills/psh-now/scripts/setup.sh` from the project folder (it re-mints/writes
  the project's paths; add `~/.agents/skills/psh-now/scripts/setup.sh` if the skill is
  machine-wide).
- Logs: `/tmp/psh-dev.log`.

## 13. Clean up afterwards

```bash
rm -rf ~/Projects/psh-test
# remove the local skill + keys (optional):
npx --yes skills remove psh-now -g; rm -rf ~/.psh ~/.agents/skills/psh-now
```

To wipe the server's data (all accounts):

```bash
psql -d pshy -c "TRUNCATE tenants, api_keys, sessions, prompts, channel_shares, channel_invites, devices, pairing_tokens, join_tokens, claims, audit_log RESTART IDENTITY CASCADE;"
```
