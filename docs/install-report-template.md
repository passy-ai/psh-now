# The install report — the template you edit

**The editable source is [`skills/psh-now/report.txt`](../skills/psh-now/report.txt)** (also
served at `https://psh.now/report.txt`). It ships **inside the skill** and `setup.sh` reads
the local copy: the text that tells an agent how to hand the report over must be versioned,
digested and reviewed with the rest of the package, never fetched at run time from the host where
it could change an agent's behaviour with no version bump (audit F7, 2026-10-18). It is inside
`public/psh-now.tar.gz`, so the archive digest covers it. Edit it like any other skill file, then
`sh scripts/sync-skill-repo.sh && sh scripts/build-tarball.sh`.

The template is markdown. Everything above the cut line
(`---8<--- everything below goes to the human…`) is **for the agent and is not handed over**.
Everything below it goes to the human **verbatim, structured as markdown** — headings, blank
lines, one list item per line, code blocks fenced. The collapse we are fixing (2026-10-17) came
from an agent reflowing those blocks into a paragraph, which glued the sign-in link to the
sentence before it and turned three commands into one line.

## What the report must establish

1. **What is installed, and where** — `{install_state}`. Machine-wide is the goal: skill at
   `~/.agents/skills/psh-now`, `psh` CLI on `~/.local/bin/psh`, machine account record at
   `~/.psh/keys.json`, plus this project's keys. When the sandbox refused those writes, the
   state line says so plainly, and `{machine_wide_note}` carries the one ask that finishes it.
2. **How to sign in** — `{app_url}`, on its own line.
3. **The keys** — `{account_key}` and `{channel_key}`, as bullets, one per line.
4. **That nothing else is needed** — the agent sends one test request right after.
5. **The claim link, only when it is relevant** — `{claim_section}` is filled **only** for a
   brand-new anonymous login (the server returns a `claimUrl` then, and never on a join or an
   already-registered account). That is the "if I do it on an existing account it doesn't need
   that" case, and it is why the section is a placeholder rather than fixed text.
6. **The prompt, in one section:** *Copy this prompt into any agent — a chat, or a sandbox* —
   `{connect_prompt}`, a command block and never prose. One block serves both: the channel key
   decides the account *and* the channel, so a sandbox-only variant would add nothing but a
   second thing to paste. The surfaces that have no key yet (the channel card, `/c/<channel>`,
   `/invite/<token>`) hand over the same wording with the channel *link* in place of the key.
   `{psh_command}` is what the human types afterwards, and `{commands_heading}` says where it
   works — `## Commands, in this folder` for the project-local install.

## Placeholders, and who fills what

| placeholder | filled by | notes |
|---|---|---|
| `{install_state}` | `setup.sh` | machine-wide vs project-local-only, with the four paths |
| `{app_url}` | `setup.sh` | the sign-in / approve link |
| `{account_key}` `{channel_key}` | `setup.sh` | masked in logs, printed for the human |
| `{claim_url}` | `setup.sh` | used inside `{claim_section}` |
| `{claim_section}` | `setup.sh` | **empty** unless a fresh anonymous account was minted |
| `{connect_prompt}` | `setup.sh` (`cp`) | **one** prompt: key block, same in a chat or a sandbox |
| `{commands_heading}` | `setup.sh` | `## Commands, anywhere on this machine` vs `## Commands, in this folder`, matched to `{psh_command}` |
| `{machine_wide_note}` | `setup.sh` | **empty** when the install is machine-wide |
| `{psh_command}` | `setup.sh` | `psh` when the CLI landed, else the project's `./.psh/bin/psh` |
| `{docs_url}` | `setup.sh` | link to the docs |

Any placeholder the template uses that `setup.sh` does not substitute ships literally — the
Docker pass asserts zero `{lower_case}` leftovers in the printed report, so add the substitution
in `.verify/docker-four-steps.sh`'s sibling check too:
`grep -oE '\{[a-z_]+\}'` over the report must come back empty.

## The policy the wording has to carry (tested, not aspirational)

- **A finished install is machine-wide.** `PSH_SKILL_DIR="$PWD/.agents/skills/psh-now"` is the
  installer's own fallback when the writes outside the workspace are refused: it works for that one
  folder, and the report never calls it machine-wide. The three pieces outside the workspace
  (`~/.agents/skills/psh-now`, a `psh` on PATH, `~/.psh/keys.json`) are the goal — not a blanket
  filesystem request made on a downloaded page's word, and not a dead end either.
- **A refusal is finished with ONE ask.** When the machine-wide writes were refused the agent
  sends `psh ask "Install psh.now globally?" "The skill and the psh CLI are this project's only.
  Approve and I will install them machine-wide."` and, on approval, re-runs the `-g` install with
  the permissions granted. Denied or unanswered: carry on project-local, say the machine-wide
  step is still theirs.
- **The verdict is machine-readable.** `setup.sh` prints `psh_machine_wide=ok` or
  `psh_machine_wide=incomplete` as its last stdout line (`install.sh` prints the same token), and
  `PSH_STRICT_MW=1` turns the incomplete case into exit 4, so no pipeline can present a
  project-local install as a finished one (audit F6). `.verify/local-flow.sh` step 6 asserts both
  directions.
- **Verify before reporting:** `sh .agents/skills/psh-now/scripts/status.sh` (or `psh status`);
  the three-part machine-wide check (`test -d ~/.agents/skills/psh-now && command -v psh && …`)
  passes exactly when the token says `ok`. The contract is written down in
  [`docs/install-contract.md`](install-contract.md).
