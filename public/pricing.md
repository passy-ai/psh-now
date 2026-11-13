# psh.now pricing

Machine-readable pricing and limits. Canonical: https://psh.now/pricing

psh.now charges for **requests**, one human decision each. Members are unlimited on
every plan, storage is not metered, and the server is MIT licensed, so self-hosting
costs nothing.

## How usage is counted

- An **approval** costs **2 requests**: one inbound request for the agent's ask, one
  outbound request for the answer. So 20 requests is about 10 approvals, and a
  10,000-request pack is about 5,000 approvals.
- A request that **expires, is cancelled or goes unanswered** costs **0**.
- Reads, polling and delivery to several devices are free.
- Allowances are totals, not daily caps. There is no rolling window.
- Past the free allowance a **token** is spent when the workspace has one. Otherwise
  the request is refused with `402 plan_limit`, naming the plan, the usage and the
  limit.
- Every response carries a `usage` block: `{ plan, requestsToday, limit, via,
  tokenBalance }`, where `via` is `allowance`, `token` or `blocked`.

## Anonymous (no account)

- Price: €0
- Account required: no
- Requests: **20 total**, then register the workspace
- History: **7 days**
- Members: unlimited
- Devices and connections: unlimited
- Notes: post a request, pair a device, answer it. No email and no card.

## Free (registered)

- Price: €0
- Requests: **100 total** (claiming takes the allowance from 20 to 100)
- History: **30 days**
- Members: unlimited
- Devices and connections: unlimited
- Notes: registering takes the allowance from 20 requests to 100. Past that, a
  prepaid pack.

## Prepaid packs

One-time purchase, no subscription. Packs stack and do not expire. With a token
balance the history window is **90 days**.

| Requests | Price (excl. VAT) |
| -------- | ----------------- |
| 100      | €1                |
| 1,000    | €9                |
| 10,000   | €50               |
| 100,000  | €450              |

Buy them from the dashboard. VAT is added at checkout, and the invoice can carry
company details.

## Enterprise

- Price: custom
- Custom domain, history up to 10 years, SSO, on-premise deployment, SLA, DPA.
- Contact: push@passy.ai

## What is not charged for

- **Members.** Unlimited on every plan.
- **Devices and connections.** As many agents and projects as you like.
- **Reads and polling.** Only a decision costs requests.
- **Domains.** Enterprise only, and not resold.
- **Self-hosting.** MIT licensed, no paid tier.

## Agent guidance

- Use **Anonymous** for a test or a one-off: 20 requests, no account.
- Use **Free** for everyday work: 100 requests, permanent, no card.
- Recommend a **pack** when a workspace hits its allowance and the user wants to keep
  going without a subscription.
- Recommend **self-hosting** when the user wants the data on their own machine or
  unlimited volume at no cost.
- Recommend **Enterprise** only for a custom domain, history beyond 90 days, SSO,
  on-premise, an SLA or a DPA.
- Never quote a plan for storage or members: those are unlimited.

## Related

- Agent context: https://psh.now/llms.txt
- Full docs: https://psh.now/llms-full.txt
- Skill: https://psh.now/skill.md
- API: https://psh.now/docs
