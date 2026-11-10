# psh.now skill

The installable skill for [psh.now](https://psh.now) - human approval for AI
agents: **approve, deny, or answer**, one request per question. This repository is
**published as a GitHub package**; the psh.now service itself is closed source.

> One host + one key + one answer. Your agent never stalls on a question.

An agent that needs a decision routes it here as a single request on its
recommended route, in one line, instead of stopping in a
terminal you can't see. You tap **Approve** or **Deny**, or type an **answer** in
your own words, from your phone or the dashboard. The agent gets one result back
and carries on.

## Install

A finished install is **machine-wide** and leaves four pieces in place:

| Piece | Where |
|---|---|
| the skill every project sees | `~/.agents/skills/psh-now` |
| the `psh` command on PATH | `~/.local/bin/psh` (or the first writable PATH dir) |
| this project's keys | `<project>/.psh/keys.json` |
| the machine account record | `~/.psh/keys.json` - keeps every project on ONE account |

The machine account record is what stops the next folder from minting a second,
invisible account. The install command is machine-wide by default for exactly that reason.

**npm - the GitHub package.** It needs npm and git, plus GitHub credentials only if that repo is
private. Nothing else is required:

```bash
npx skills add passy-ai/psh-now-skill -g -y
```

That one command fetches the repo and runs its `install.sh` as its bin, so it copies
the skill machine-wide, mints the account record, installs the `psh` CLI and prints the
verdict. One command, so the human's harness asks for approval once.

**curl - the credential-free route** (no npm, no git, no repo access). It verifies
every file it downloads against the per-file sha256 manifest it fetches from
`/.well-known/agent-skills/files.json`, and **refuses** to install when that
manifest is missing or a file does not match - a refusal, not a warning.
`PSH_NO_VERIFY=1` overrides the missing-manifest refusal (and says the install is
unverified); it does not override a mismatch:

```bash
curl -fsSL https://psh.now/install.sh -o /tmp/psh-install.sh && bash /tmp/psh-install.sh
```

Inside a sandbox that can only write the workspace, the machine-wide writes are
refused. That is **not** a finished install and the run says so:
`psh_machine_wide=incomplete` as the last line of `setup.sh` (exit 4 with
`PSH_STRICT_MW=1`), and `MACHINE-WIDE INCOMPLETE` from `install.sh`. The
project-local copy still works - the skill and `./.psh/bin/psh` inside the folder,
keys in `./.psh/keys.json`. Finish it with **one** ask through psh.now, then a
re-run with the permissions granted:

```bash
psh ask "Install psh.now globally?" "The skill and the psh CLI are this project's only. Approve and I will install them machine-wide."
```

The installer records the host and the keys for you. To set them yourself, use the
environment, or `<project>/.psh/keys.json`, with this machine's account in
`~/.psh/keys.json` as the fallback:

```bash
export PSH_BASE_URL="https://psh.now"
export PSH_API_KEY="psh_agent_..."
```

`psh` (installed on PATH) prints where everything is.

## What the agent does

```bash
curl -s -X POST "$PSH_BASE_URL" \
  -H "x-psh-key: $PSH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Create src/ and PLAN.md?","message":"I will create src/ and write PLAN.md, with no source files yet."}'
```

The human has three buttons, so one of these comes back:

```json
{ "status": "approved", "approved": true,  "answer": null }
```

```json
{ "status": "denied",   "approved": false, "answer": null }
```

```json
{ "status": "answered", "approved": false, "answer": "use the staging branch, not prod" }
```

Proceed only when `status` is exactly `approved` and `approved` is `true`.
`answered` is **not** a yes and not a no - it is instruction: read `answer`, do
what it says, and if it left the action undecided, ask again. A timeout, a proxy
error, a `pending` request, or anything else means **do not act**. Silence is
never consent.

Keep it to one screen: one request per question - the question itself as the first line, then
one sentence saying exactly what you will do.

## Pair a device

Open your sign-in link (`<host>/app#key=<user key>`) in the dashboard, then use
**Pair device** to show a QR/link, open it on your phone, and tap **Pair this
device**. Approvals then land on your lock screen; without a paired device they
still wait on the dashboard.

## Docs

- Full agent contract: [`SKILL.md`](SKILL.md) - also served at <https://psh.now/skill.md>
- Host docs: <https://psh.now/docs>
- Agent context: <https://psh.now/llms.txt> · <https://psh.now/llms-full.txt>
- Agent manifest: <https://psh.now/.well-known/agent.json>
- Artifact index + digest: <https://psh.now/.well-known/agent-skills/index.json>

## Layout

```
SKILL.md                  the skill (Agent Skills format)
README.md                 this file
LICENSE                   MIT
package.json              name + bin, for the npm route
host                      the baked-in host (a non-dotfile, so `npx skills add` copies it)
install.sh                the credential-free installer (covered by the tarball digest)
report.txt                the install-report template (versioned with the skill)
scripts/ask.sh            send one request (the only runtime need)
scripts/setup.sh          mint keys once / attach via a channel link / --uninstall
scripts/status.sh         healthy, reachable, authenticated? --doctor adds a map
scripts/psh.sh            the `psh` command
```

Everything in this package is generated from the service repo's `skills/psh-now/`
tree by `scripts/sync-skill-repo.sh`; edit it there, not here. The digest-covered
archive at <https://psh.now/psh-now.tar.gz> is built from that package.
