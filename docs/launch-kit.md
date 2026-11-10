# Launch kit: the directory pass

Everything needed to get psh.now onto the launch directories, in the order that costs the least time.

**The one blocker:** every directory below needs an account, and most confirm it by email. An agent
cannot finish that step. What is done here is everything up to the signup, the canonical copy, the
assets, and a per-directory note on what it costs and what it asks for, so each one is a copy-paste
of a form you are already logged into.

Checked 10 November 2026. Prices and paths move; re-check anything marked "seen on page".

---

## 1. Canonical copy

Paste these, don't rewrite them per directory. One description everywhere is what makes a product
recognisable across listings, and it is what a model answering "what is psh.now?" will quote.

| Field | Value |
| --- | --- |
| Name | `psh.now` |
| Tagline (≤ 60) | Approve what your AI agent does next, from your phone |
| Short (≤ 160) | psh.now is the human-approval hub for AI agents: the agent asks with one HTTP call or one MCP tool, you tap Approve or Deny on any device, and it gets a boolean back. |
| Long (~400) | psh.now is where an AI agent stops and asks a person. The agent sends a short title and message over one HTTP call (or one MCP tool) and blocks. You answer on your phone, tablet or desktop: Approve, Deny, or type an answer to a question. The agent gets a boolean and continues, so a run that would have stalled at 2am finishes. Keys are ask-only: an agent can request an approval and can never grant one. Channels are shared, so a whole team can answer one channel and see who approved what. Open source, MIT, self-hostable, no SDK to install. |
| Categories | Developer Tools · AI · Productivity · Open Source |
| Tags | ai-agents, human-in-the-loop, approvals, agent-permissions, claude-code, codex, cursor, mcp, self-hosted, open-source, mit, bun |
| Licence | MIT |
| Pricing | Free to start (20 requests), 100 after claiming an account, prepaid packs from €1 |
| Website | https://psh.now |
| Repository | https://github.com/passy-ai/psh-now |
| Docs | https://psh.now/docs |
| Agent integrations | https://psh.now/agents |
| Logo (512×512 PNG) | https://psh.now/website/logo-512.png |
| Social image (1200×630) | https://psh.now/website/og.png |
| Contact | hello@psh.now |

**One line about what it is not**, for any form with a "how is this different" box: it is not another
agent and not a proxy on top of one, it is the place a decision goes when the agent cannot make it.

---

## 2. The directories on SuperBased's list

All 23 are checked reachable. "Money" is what the submit or pricing page showed, not a promise of a
free listing: most have a free tier and a paid boost.

| # | Directory | Submit | Money | Notes |
| --- | --- | --- | --- | --- |
| 1 | [twelve.tools](https://twelve.tools) | https://twelve.tools/submit | free tier, paid up to $36 | Redirects `/submit` → pricing. Free listing is reviewed manually |
| 2 | [Aura++](https://auraplusplus.com) | /pricing | $0, $1, up to $139 | Launch-kit page at `/launch-kit` is worth reading first |
| 3 | [Launch Vault](https://www.launchvault.dev) | no `/submit` page found | - | Submit from the site's own nav; check the redirect target |
| 4 | [ShipBoost](https://shipboost.io) | https://shipboost.io/submit | from $1, up to $26 | |
| 5 | [TinyHunt](https://tinyhunt.dev) | /pricing | $0, $1, $10 | |
| 6 | [Findly Tools](https://findly.tools) | https://findly.tools/launch | $1–$13 | Also sells a 30/60/100-directory pass ($59/$99/$139), see §4 |
| 7 | [MakerHunt](https://makerhunt.io) | https://makerhunt.io/submit | $1, $14, $28 | |
| 8 | [Startup Fast](https://www.startupfa.st) | no `/submit` page found | - | |
| 9 | [Huzzler](https://huzzler.so) | no `/submit` page found | - | Sells launch-directory packs as products |
| 10 | [LaunchIgniter](https://launchigniter.com) | https://launchigniter.com/submit | $1, $11, $13 | |
| 11 | [Smol Launch](https://smollaunch.com) | https://smollaunch.com/submit | $1, $49, $99 | Free mentions are common on this one |
| 12 | [Fazier](https://fazier.com) | https://fazier.com/submit | $29–$49 | Paid-forward |
| 13 | [StartupBase](https://startupbase.io) | https://startupbase.io/launch | $0, $29, $39 | |
| 14 | [Neeed Directory](https://neeed.directory) | https://neeed.directory/submit | free tier, $19 | |
| 15 | [UNO Directory](https://uno.directory) | /pricing | $1, $2, $10 | AI-tools shaped; our MCP endpoint fits its listings |
| 16 | [SideHunt](https://sidehunt.io) | https://sidehunt.io/submit | $1, $14, $28 | |
| 17 | [Daily Pings](https://dailypings.com) | /pricing | free tier, $10 | |
| 18 | [Indie Hunt](https://indiehunt.io) | https://indiehunt.io/submit | $1, $14, $17 | |
| 19 | [Tool Pilot](https://www.toolpilot.ai) | no `/submit` page found | - | Next.js app; submit flow is behind the nav |
| 20 | [Try Launch](https://trylaunch.ai) | https://trylaunch.ai/submit | no prices on page | |
| 21 | [Startup Ranking](https://www.startupranking.com) | site is behind Cloudflare | free | Needs a real company profile, not a product listing |
| 22 | [Clutch](https://clutch.co) | behind Cloudflare | free to be reviewed | For agencies/companies; probably wrong shape for psh.now |
| 23 | [Firsto](https://firsto.co) | /pricing | $0, $1, $179 | |

Judgement: **1–20 are worth it; 21–23 are a company-profile play, not a product listing.** Clutch in
particular is an agency directory, listing a developer tool there wastes a review cycle.

---

## 3. SourceForge

Free, no listing fee, and it is the one on this list with real domain authority behind it.

- Create: https://sourceforge.net/p/add_project
- **Import straight from GitHub:** https://sourceforge.net/p/import_project/github/, the shortest path, since the code is already public.
- Needs a SourceForge account (email confirmation).
- Ask for: category (Developer Tools / Software Development), licence MIT, the copy in §1, and the logo.
- Worth doing first: it is free, permanent, and the project page carries the description a model will read.

Note: no domain matching "scourgeforge" resolves (checked .com/.io/.dev/.ai/.app/.net/.org), so this
assumes SourceForge was meant.

---

## 4. The paid short-cut

[Findly's directory packs](https://findly.tools/directories/submit.md) are $59 for 30 submissions, $99
for 60, $139 for 100, done by hand, with a report and screenshots, and they throw in Premium listings
on Findly, DailyPings, Launchy and ToolRoots ($66.90 of list price). It is the honest version of this
table: someone else fills in the 30 forms.

If the goal is "be on all of them this week" rather than "be on them one at a time", that is the
cheapest route in hours. It is a purchase, so it needs your card, not mine.

---

## 5. Already done, no accounts needed

| Surface | Why it matters for AI recommendations |
| --- | --- |
| GitHub topics (20 of them) | `mcp`, `mcp-server`, `claude-code`, `hitl`, `agent-permissions` and the rest. GitHub search and model training both read these |
| GitHub description + homepage | Shown in search results and in the repo card models quote |
| `/llms.txt` and `/llms-full.txt` | The typed summary an LLM reads instead of scraping the HTML |
| `/skill.md` + skills.sh listing | https://www.skills.sh/svliantiss/psh-now-skill. 3 installs, one entry, no duplicate under the `passy-ai` name |
| `/agents` (10 pages) | One page per harness, each with HowTo structured data |
| `/openapi.json`, `/.well-known/mcp.json` | Machine-readable descriptions of the same product |

**Awesome lists.** `awesome-claude-code` requires either 14 days of commits or 100 stars before a
submission is read at all, it auto-closes anything else, so that one waits a fortnight.

`awesome-mcp-servers` has no such gate and explicitly fast-tracks agent PRs, so that is open now:
[PR #19131](https://github.com/punkpeye/awesome-mcp-servers/pull/19131), one line under Developer
Tools on branch `add-psh-now`. A matching entry in `awesome-remote-mcp-servers` is the next one if a
hosted-first server is judged a better fit there.

---

## 6. Tracker

| Directory | Submitted | Listed | URL |
| --- | --- | --- | --- |
| GitHub | yes | yes | https://github.com/passy-ai/psh-now |
| GitHub Releases | yes | yes | https://github.com/passy-ai/psh-now/releases |
| skills.sh | yes | yes | https://www.skills.sh/svliantiss/psh-now-skill |
| awesome-mcp-servers | PR open | pending review | https://github.com/punkpeye/awesome-mcp-servers/pull/19131 |
| SourceForge | no | no | - |
| 1–20 above | no | no | - |

When one goes live, add it to `/listed-on` so the page stays a record of real listings rather than a
wish list.
