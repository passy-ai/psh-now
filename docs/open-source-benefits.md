# Open source, your surfaces — and why the hosted tier still matters

_psh.now is open source under MIT (© Absolum). The gateway, the skill, the
three scripts, the database schema, the dashboard — all of it is in this
repository, line by line. This page is the honest map of what "open" buys
you: what you can customize **today** around the hosted service, what you can
customize by self-hosting, and why the hosted tier is still worth a price
once you've seen the whole machine._

---

## 1. The split that makes both true

| | In the repo (MIT, inspectable) | The hosted service (psh.now) |
|---|---|---|
| What it is | the whole machine: gateway, skill, CLI, dashboard, schema, self-host guide | the same gateway, running on always-on infrastructure |
| Runs | your box, your VM, your CI, your cluster | our box, with monitoring, updates, backups |
| Costs you | your time to run it | a price, metered in requests |
| Changes | any edit you want, keep the fleet | the fleet stays current for you |

**The rule of thumb:** *open source = your surfaces; hosted = your delivery.*
A fork gets everything, at ops cost. A tweak gets everything, for free.

## 2. What you can customize today (no server changes at all)

The hosted service is an API with a few well-defined surfaces. Everything an
agent can do, your code can do, audited the same way:

| You want to… | How, today |
|---|---|
| Change **when agents ask** — the doctrine | Edit the skill (`SKILL.md` is three plain POSIX scripts + markdown). Stricter, looser, your house rules — the doctrine is yours |
| Script asks from your own app / cron / pipeline | The CLI (`psh`) or one HTTP POST — the same call the skill makes |
| Build your **own review surface** (Slack bot, Teams bot, on-call pager) | Read pending prompts from the API, decide them with your approver key, show owners everything |
| Embed approvals **in the product you're building** | Yes — a paired channel key makes your users approvers of *your* agents; the card, the `decidedBy` record, the answer text are all the hosted product's |
| Watch decisions live in your own tooling | The WebSocket (`/ws`) or `wait:false` + `pollUrl` long-poll — every decision, the moment it lands |
| Keep the record | Every prompt stores who/what/why decided — your compliance export is one query |

Free surface design: your surface can filter (read-only kinds), fork (a copy
that routes around), or replace (a surface that *is* the product for your
team). The hosted tier accepts all of it — it doesn't know or care which
client asked, only which key.

## 3. What self-hosting adds (the fork path)

Run it yourself via `docs/self-hosting.md`: the gateway is one Bun server +
Postgres. Once it's yours the *whole product* is clay:

- Rebrand surfaces (your domain, your card copy, your report templates).
- Run the meter however you like — the ladder and grace window are your
  code now; self-hosted never sees the billing features.
- Ship changes the hosted fleet can't take yet: personal fields,
  irregular review types, region-pinned storage, air-gapped installs.
- Own the data path end to end — nothing about an agent's question or your
  answer leaves your perimeter.

Forks stay light because the *interface* is the stable part: one POST, one
poll URL, one decision payload. Build against those and you're compatible
with both your fork and the hosted service forever.

## 4. Roadmap: the connector API (webhooks)

`docs/webhooks.md` (designed, not shipped yet) adds the missing piece for
CI/Slack/ticket-style tooling: every decision POSTs a signed JSON body to
endpoints *you* register — "build your own connector" without even holding a
connection. Today the equivalent is the WebSocket or the long-poll; the
webhook spec exists precisely so integration — not our copy of it — is the
thinnest thing in the middle.

## 5. Why the hosted tier still earns its price once it's all open

Three reasons, none of them secrecy:

1. **Phone delivery is real infrastructure.** Pushing to your phone the way
   you want — push registration, wake behavior, ordering, retry on flaky
   networks — is the part that gets annoying to run yourself; the hosted
   tier does it as a discipline.
2. **Records, uptime, and updates are the service.** The decision record is
   the thing a team actually relies on — who decided what, when, with what
   words — and it stays good only if somebody is patching, backing up, and
   watching. That's what the hosted fleet is for.
3. **Metering needs an operator to be fair.** The free rack, the grace
   window, the packs — meters are honest only when someone runs them
   neutrally. Self-host drops billing entirely; the hosted tier runs the
   ladder from the pricing page.

The Piracy doctrine, stated as service instead of walls: **go ahead — read
it, fork it, run it, customize it.** If it's running somewhere you trust
without you babysitting it, that's the product, and the fast path is
[`https://psh.now/setup.md`](https://psh.now/setup.md).
