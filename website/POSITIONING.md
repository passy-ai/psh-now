# Positioning notes — source of truth for site copy

Captured from the founder. Re-read this before editing any marketing copy.
This is the authority for *what we claim*; `src/` is the authority for *what is true*.

## The two pains, in priority order

1. **Agents break stuff.** The primary pain. Destructive or irreversible steps
   taken without a human seeing them. This leads.
2. **Agents stall.** Agents dying, or sitting blocked waiting for you. Keeping the
   flow going is *equally important*, not a secondary benefit.

Both must be visible in the hero. Neither alone is the pitch.

## Where we genuinely win

- **Installable and usable immediately.** No setup theatre, no waiting on a
  platform to provision something. Start answering in a minute.
- **A skill as a service — not a platform with a skill.** This is the structural
  difference. We are not a platform that also ships a skill; the skill *is* the
  product surface.
- **Agent-first.** Designed from the agent's side of the wire outward.
- **Agent-agnostic with no packages.** Any agent that speaks HTTP works. Nothing
  to install into your agent, no SDK, no adapter package.
- **Free without a trial.** No trial clock, no card, no account required. A real
  differentiator against trial-gated competitors.

## Delivery reality — do not overclaim

- **No APN / push notifications yet.** Do not promise push, notifications,
  background alerts, or "your phone buzzes".
- **We DO have PWA install.** That is the honest claim: installable to the home
  screen so it travels with you. Phrase it as PWA install, not as notifications.
- **We DO have the dashboard**, which receives and can answer requests. When
  someone is at a screen, the dash is the delivery surface.
- Anything claiming a notification will reach you when the app is closed is
  **false today**. See `HANDOFF.md` for the notifications work.

## What we are deliberately learning from Pushary

**One tap to answer** is the thing worth copying. Pushary's framing is right and
ours should match it.

The valuable case is **not** complicated reviews or open-ended questions. It is
the opposite: **a flow that pushes five questions into one recommended route.**
Five separate asks should collapse into a single decision the human taps once —
the agent has already done the reasoning, the human just confirms the route.

### Hard constraint to resolve before writing this copy

`looksLikeMenu()` in `src/routes/hook.ts` **rejects** exactly this shape. It
throws `badRequest` when a message contains:

- `>= 3` question marks, or
- `>= 2` option markers (`A)`, `B.`, `C)`, `D.`), or
- `>= 3` occurrences of "or"

with the message: *"psh.now has only Approve and Deny — ask one yes/no on your
recommendation. Do not list options (zsh/bash/fish, A/B/C, several questions).
Pick one and ask to proceed."*

So "five questions into one recommended route" is **already the enforced
contract for a single request** — the agent must collapse the options itself and
ask one yes/no on its recommendation. What does *not* exist yet is true
multi-question batching inside one decision.

Decide which this is before writing the copy:
- **(a)** Copy only: the agent collapses and recommends; we describe the existing
  single-yes/no-on-a-recommendation contract. No code change.
- **(b)** Product change: psh.now itself groups several asks into one decision
  with a recommended route. Requires schema, API, and dashboard work.

Do not write hero copy implying (b) until (b) exists.
