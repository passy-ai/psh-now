# Security - the psh.now skill

_config: internal artifact + `security.md` for the published skill repo (checklist 3.7)._

## What this skill does

psh.now routes a question the agent was already going to ask into one human
decision: the agent POSTs `{"title","message"}`, the user taps **Approve** or
**Deny** - or types their own **answer** - from anywhere, and the agent gets one
result back. It exists so agents stop stalling in a terminal nobody is watching.

## What runs on the machine

Four POSIX `sh` scripts that come with the skill (`ask.sh`, `setup.sh`,
`status.sh`, `psh.sh`), plus the one-shot `install.sh`. They are plain shell -
**no `eval`, no `sudo`, no service daemon** - and they touch only:

| Location | Why |
|---|---|
| `<project>/.psh/keys.json` · `host` | the channel key + baked-in host (mode `0600`) |
| `<project>/.psh/config.json` · `README.md` | the `psh` CLI's config + a plain-text breadcrumb |
| `~/.psh/keys.json` · `host` | this machine's account, written by the first install (never overwritten while it is still valid) |
| `~/.psh/config.json` · `README.md` | only created when absent or when they already point at that workspace |
| `~/.agents/skills/psh-now/` | the machine-wide skill copy (real files, not a symlink) |
| one PATH directory | the `psh` command (`~/.local/bin`, `~/.bun/bin`, …), recorded in `.psh-bin` for `--uninstall` |
| `<skill dir>/.keys.json` | read-only legacy fallback; never written |
| `stdout` / `stderr` | result (`psh_result.*`) and progress |

Everything else the scripts do is an HTTPS call to the configured host.

## What is sent

One UTF-8 JSON body per ask:

```json
{"title":"…", "message":"…", "agent":"…", "cwd":"…", "wait":true}
```

- **`title` + `message`** - what the agent writes for the human to read.
  There is **no file content, no code, no key material, no command output**
  unless the agent itself chooses to quote it in `message`. The human reads it
  before deciding.
- **`agent`** (optional) - display name of the calling harness
  (`claude-code`, `cursor`, …). Present so a human can tell which agent asked.
- **`cwd`** (optional, off by default) - path of the working directory.
- **The channel key** goes in the `x-psh-key` header. It is **ask-only**: it
  can create approval requests and read their result, and nothing else. The
  *account* (`userKey`) key is the one that signs in to the app.

## What comes back

`status` is one of `approved`, `denied`, `answered` or `expired`, with `approved`
a boolean and `answer` a string (the human's own words on `answered`, else
`null`) - plus `decision` (which option on a batched ask) and `pollUrl`. Nothing
else. The agent does not get codes, emails, or device lists from an ask.

Act on `approved: true` only when `status` is exactly `approved`. `answered` is
**not** a yes and not a no: it is instruction, and it never stands in for
`approved: true` when the action needs approval. Everything else - `denied`,
`expired`, a timeout, a dropped connection, a non-2xx - means **do not act**.

## Honest limits (please read)

- The skill **guides the model; it does not enforce**. An agent can skip
  asking. Enforcement belongs to the harness, the OS, or your own
  policy - psh.now deliberately stays harness-agnostic (no SDK, no MCP).
- Approvals are granted per decision, not per session. Silence is never
  consent; a timed-out ask resolves to `false`.
- The message is written by the asking agent. The human and the network
  should treat it as untrusted text, not as proof of what will actually run.

## How to audit the install without trusting the installer

The genuinely auditable path is the **digest-covered tarball**. The host publishes
`https://psh.now/.well-known/agent-skills/index.json`, whose `sha256:<hex>`
digest covers the artifact at `https://psh.now/psh-now.tar.gz`. That archive
is built from the published package, so it holds everything the install puts on
disk - `SKILL.md`, `install.sh`, `report.txt`, the scripts, `README.md`,
`SECURITY.md`, `AGENTS.md`, `LICENSE`, the assets and the plugin manifests - and
verifying it covers the installer too. This runs on stock macOS/Linux tools, and
prints `ok` or `MISMATCH`:

```bash
url=https://psh.now
want=$(curl -fsSL "$url/.well-known/agent-skills/index.json" \
  | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"sha256:\([0-9a-f]\{64\}\)".*/\1/p' | head -1)
curl -fsSL "$url/psh-now.tar.gz" -o psh-now.tar.gz
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum psh-now.tar.gz | awk '{print $1}')
else
  got=$(shasum -a 256 psh-now.tar.gz | awk '{print $1}')
fi
if [ -n "$want" ] && [ "$want" = "$got" ]; then
  echo "ok - psh-now.tar.gz matches the published sha256"
else
  echo "MISMATCH"; echo "published  $want"; echo "downloaded $got"; exit 1
fi
tar xzf psh-now.tar.gz    # read install.sh and scripts/*.sh before running them
```

`install.sh` goes further and verifies **every file it downloads**, byte for byte,
against the per-file manifest it fetches from
`https://psh.now/.well-known/agent-skills/files.json`. The keys are the file
names as served (`skill.md`, `ask.sh`, `setup.sh`, `status.sh`, `psh.sh`,
`install.sh`, `report.txt`); each value is the sha256 of the exact served bytes.
(`install.sh` is in the manifest so the tarball check covers it; the copy already
running cannot verify itself.)

- A missing or unreadable manifest is a **refusal**, not a warning: the installer
  stops. So is a file **not covered** by the manifest, and so is any **mismatch**
  (published vs downloaded digests are printed before it stops).
- `PSH_NO_VERIFY=1` overrides the missing-manifest refusal only - the install
  proceeds and warns that it is unverified. It does **not** override a mismatch:
  a wrong digest still stops the install.
- `PSH_DIGEST_URL` points the check at a different manifest (self-hosted hosts).

**npm - the GitHub route.** `npx skills add passy-ai/psh-now-skill -g -y` installs from the
GitHub repo `passy-ai/psh-now`. It needs npm and git, plus GitHub credentials when that
repo is private, and nothing
about it is anonymously readable: a credential-free `git ls-remote` against it
fails, unlike a public control repo. Use it when you have that access and would
rather read the repo than the archive.

**The download-and-run fallback** exists for machines without npm, git or repo access,
and it is the route that needs no credentials. If you would rather not pipe blind
at all, read this one file first - it is ~300 lines of POSIX `sh`, digest check
included:

```bash
curl -fsSL https://psh.now/install.sh -o install.sh
${EDITOR:-vi} install.sh
sh install.sh
```

## Reporting

Contact the operator: **[absolum.nl](https://absolum.nl)** - or, if you have
access to the repo (`passy-ai/psh-now`), open an issue there. The
skill's own scripts are the audit surface; the service itself is closed-source and
should be treated as a black box **on your own domain** if you self-host it.
