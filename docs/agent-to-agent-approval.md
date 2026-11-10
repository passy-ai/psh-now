# Agent-to-agent approval (autonomous)

Make one agent answer another agent's questions, so a pipeline runs with **no
human in the loop**, or with a human only for the risky bits.

## The model

| Role | Key | Can |
|---|---|---|
| **Requester** | channel key (`scope: ask`) | create requests, read its own |
| **Approver** | account key (`scope: manage`) | list pending, approve/deny |

An `ask` key can **never** approve, that's the whole point of the scope split.
So the approver needs the **account key** (or a paired device). Give the approver
key only to a box you control.

```
requester ── POST / (channel key) ──▶ psh.now ──▶ approver polls (account key)
                                              ◀── POST /approvals/:id/decision
```

## Minimal setup (3 steps)

1. **One channel** for the flow, e.g. `"CI"`. `/app` → **＋ New channel**.
2. **Requester** gets that channel's key: channel → **Connections** → copy the
   key. It asks normally (`ask.sh`, or any HTTP call).
3. **Approver** gets the **account key** (account card → copy) and runs the loop
   below.

That's it, no new accounts, no extra services.

## The approver loop

Save as `approver.mjs`. It long-polls pending requests and applies your policy.

```js
// approver.mjs: answer psh.now requests autonomously.
const HOST = process.env.PSH_BASE_URL ?? "https://psh.now";
const KEY = process.env.PSH_ACCOUNT_KEY;        // the ACCOUNT key (manage scope)
const CHANNEL = process.env.PSH_CHANNEL ?? "";  // optional: only this channelId

if (!KEY) throw new Error("set PSH_ACCOUNT_KEY to the account key");

const api = (path, init = {}) =>
  fetch(HOST + path, {
    ...init,
    headers: { "x-psh-key": KEY, "content-type": "application/json", ...init.headers },
  }).then((r) => r.json());

// ── Your policy. Return true to approve, false to deny, null to leave for a human.
function decide(req) {
  if (/rm -rf|drop table|force-push|sudo/i.test(req.message)) return false;
  if (req.kind === "action") return true;
  return null; // escalate anything ambiguous
}

console.log("psh approver running…");
for (;;) {
  const { prompts = [] } = await api("/api/v1/approvals?status=pending");
  for (const p of prompts) {
    if (CHANNEL && p.connectionId !== CHANNEL) continue;
    const verdict = decide(p);
    if (verdict === null) continue; // leave pending for a human
    await api(`/api/v1/approvals/${p.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        approved: verdict,
        reason: verdict ? "auto-approved by policy" : "blocked by policy",
      }),
    });
    console.log(`${verdict ? "✓" : "✗"} ${p.title}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
```

Run it:

```bash
PSH_ACCOUNT_KEY="psh_user_…" node approver.mjs
```

## Escalation (keep the human in the loop for some things)

`decide()` returning `null` leaves the request **pending**, it stays on the
user's page and they can still approve it. So the pattern is:

- **Auto-approve** the boring, reversible stuff.
- **Escalate** (`null`) anything ambiguous.
- **Auto-deny** the obviously dangerous stuff.

You can also change the decision later: `POST /api/v1/approvals/:id/decision`
with the opposite value updates the row (the last decision wins), so an approver
can flip a request it regrets.

## Real-time (optional)

Polling every 3s is fine. For instant handling, the approver can open the same
WebSocket the app uses (`GET /ws?token=<account key>`, see
`src/routes/ws.ts`), receive `prompt.created`, and decide immediately. Polling is
the minimal setup; the socket is the low-latency one.

## Multi-agent patterns

- **One approver, many requesters**: all requesters use channel keys on one
  channel; one approver handles the channel. Simplest.
- **One approver per channel**: give each approver the account key and set
  `PSH_CHANNEL=<channelId>` so it only touches its own channel.
- **Chained approval**: a request that's approved can itself trigger the next
  request; each step is one binary.

## Security notes (read before shipping)

1. **The account key is full-manage.** The approver can also create keys, revoke
   devices, and change the account. Treat it like a root credential: one box,
   secrets manager, no logs.
2. **There is no channel-scoped manager key yet.** Scoping to a channel is done
   in the approver loop (`PSH_CHANNEL`), not enforced by the server. If you need
   hard isolation, use a **separate account** for the autonomous flow and share
   just that channel to your main account.
3. **Audit.** Every decision stores `reason` and, for device decisions,
   `deviceId`. Use a clear `reason` (`"auto-approved by policy v3"`) so the audit
   log explains itself.
4. **Timeouts.** A request with no decision auto-denies at `timeoutMs` (default
   90s; async requests stay answerable for 24h). Set `timeoutMs` deliberately.

## Why not just give the requester the account key?

Because then one compromised agent has the whole account. Keeping requesters on
`ask` keys means a prompt-injected requester can only *ask*, it can never
approve itself. The approver is the one place that decides.
