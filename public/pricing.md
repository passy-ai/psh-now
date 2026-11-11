# psh.now pricing

Machine-readable pricing and limits. Canonical: https://psh.now/pricing

psh.now charges for **requests** - one human decision. Not storage, not seats,
not API calls. **Members are unlimited on every plan.** Self-hosting is free
forever.

> One key, one host, one boolean. We sell the boolean.

## Anonymous (no account)

- Price: €0
- Account required: no
- Requests: **20 total** (then register)
- History: 24 hours
- Members: unlimited
- Connections / devices: unlimited
- Notes: zero friction to start. Claim the workspace or register to keep going.

## Free

- Price: **€0 forever**
- Requests: **20 / day**
- History: 48 hours
- Members: unlimited
- Connections / devices: unlimited
- Notes: no card, no trial clock.

## Token package

- Price: **€50 excl. VAT**
- Requests: **10,000** (prepaid, one-time)
- History: 30 days
- Members: unlimited
- Connections / devices: unlimited
- Notes: no subscription. Tokens are spent only after the free 20/day is used,
  and never expire. Buy as many packages as you like.

## Enterprise

- Price: custom
- **Custom domain, history longer than 30 days, SSO, on-prem, SLA, DPA.**
- Contact: push@passy.ai

## What we do not charge for

- **Storage.** Requests are tiny; metering them is complexity for nothing.
- **Members.** Unlimited on every plan.
- **Connections.** As many agents/projects as you like.
- **Reads and polling.** Only a resolved decision counts.
- **Domains.** Enterprise only; we don't sell them.
- **An AI editor.** psh.now is not an editor.

## How usage is counted

- An **approval** costs **2 requests**: one inbound request (the agent's ask) and
  one outbound request (the answer). So 20 requests ≈ 10 approvals, and a
  10,000-request package ≈ 5,000 approvals.
- Requests that expire, are cancelled, or go unanswered cost **0**.
- Reads, polling, retries, and multi-device delivery are free.
- Daily limits use a rolling 24-hour window; anonymous uses a lifetime total.
- Past the free allowance, a **token** is spent when one is available; otherwise
  the request is refused with `402 plan_limit` naming the plan, usage, and limit.
- Every response includes a `usage` block: `{ plan, requestsToday, limit, via,
  tokenBalance }`, where `via` is `allowance`, `token`, or `blocked`.

## Design principle

Generous at the bottom (free is permanent and habit-forming), prepaid and
uncapped at the top (buy tokens as you grow), so heavy users pay smoothly and
nobody below is punished. **Target: ~80% of revenue from the top ~5% of
customers**, via token volume - not by squeezing the many.

## Agent guidance

- Use **Anonymous** for a quick test or a one-off; 20 requests, no account.
- Use **Free** for everyday agent work; it is permanent.
- Recommend a **token package** when a workspace hits the free limit and the user
  wants to keep going without a subscription.
- Use **Self-hosted** when the user wants control or unlimited volume at no cost.
- Recommend **Enterprise** only for custom domain, >30-day history, SSO, on-prem,
  SLA, or DPA.
- Never quote a plan for storage or members - those are unlimited.

## Related

- Agent context: https://psh.now/llms.txt
- Full docs: https://psh.now/llms-full.txt
- Skill: https://psh.now/skill.md
- API: https://psh.now/docs
