# psh demo

A tiny project for testing psh with any AI agent.

- **Host:** https://refer-hospitality-immediate-donors.trycloudflare.com
- **Workspace:** dSkA0Nmw6x7
- The rule the agent must follow is in **`agents.md`** (it contains the key).

---

## 1. Pair your phone

On your phone (same Wi‑Fi), open this **https** link and tap **Pair this
device**:

```
https://refer-hospitality-immediate-donors.trycloudflare.com/pair/ANd1sUHf6FKJdX7Q9mr9sX
```

> HTTPS is required for notifications. If the link expired, run `psh pair` in
> this folder to mint a new one. The `https://…trycloudflare.com` host is a
> temporary tunnel to this machine; see the top-level README to make it
> permanent.

## 2. Open your agent here and give it a safe task

Open your agent in *this folder* and say:

> Read agents.md and follow it. Then list the files here.

This should **not** ask for approval — it's read-only.

## 3. Trigger an approval

Tell the agent:

> Reset dependencies: permanently delete node_modules and package-lock.json,
> then run npm install --force. Follow agents.md.

Your phone should buzz with a **title + message**. Tap **Approve** or **Deny**.

- Approve → the agent runs the command and reports back.
- Deny → the agent stops, changes nothing, and offers alternatives.

## Test without an agent (two ways)

Dashboard button:

```
https://refer-hospitality-immediate-donors.trycloudflare.com/app
```

From this folder:

```bash
psh ask "Permanently delete node_modules and reinstall" --title "Reset deps"
```

## Watch what's pending

```bash
psh status
```

---

> ⚠️ `agents.md` contains a real API key for this demo workspace. Don't commit it.
