# The install contract (one page, so fixes stop being per-transcript)

Every "it didn't install globally" incident since 2026-10-17 (audit: 15 comments keyed to that
date, four files) was a patch applied to one transcript against no written spec. This is the
spec. `.verify/local-flow.sh` step 6 asserts it; if you change behaviour here, change that too.

## What "installed" means

Four pieces, and a finished install has all four:

| # | Piece | Path | Written by |
|---|---|---|---|
| 1 | the skill every folder sees | `~/.agents/skills/psh-now` | `-g`/machine-wide copy |
| 2 | the `psh` CLI on PATH | first writable dir already on PATH | the shim step |
| 3 | the machine account record | `~/.psh/keys.json` (override: `GLOBAL_DIR`) | `setup.sh` |
| 4 | this project's keys | `<project>/.psh/keys.json` + `./.psh/bin/psh` | `setup.sh` |

Pieces 1–3 need writes **outside** the workspace. A `workspace-write` sandbox gets only piece 4.
That is a working project-local install and an **unfinished** machine-wide one.

## The two documented routes

```bash
# 1. the package repo - needs npm + git (credentials only if it is private), and it is the global one
npx skills add passy-ai/psh-now-skill -g -y

# 2. the hosted installer — needs no credentials, and verifies every file it downloads
curl -fsSL https://psh.now/install.sh | sh
```

Route 2 is what an auditor can check: `public/psh-now.tar.gz` carries `install.sh` itself (F5),
its digest is in `/.well-known/agent-skills/index.json`, and every file the installer downloads
is checked against `/.well-known/agent-skills/files.json` (F11) — a mismatch is a refusal, not a
warning. Piping to `sh` runs the installer before you have read it; to check it first, hash it
against its published digest without writing anything to disk:
`curl -fsSL https://psh.now/install.sh | sha256sum`. `PSH_NO_VERIFY=1` is the documented override. The report template is inside the package
(F7): nothing that instructs an agent is fetched at run time.

## When the machine-wide writes are refused

1. Say it in one line — this project works, the machine does not yet.
2. Send **one** ask: `psh ask "Install psh.now globally?" "The skill and the psh CLI are this
   project's only. Approve and I will install them machine-wide."`
3. Approved → re-run the install line with the permissions granted.
4. Denied or unanswered → carry on project-local and leave it. Never call it finished.

## The signal

`setup.sh`'s **last stdout line** is `psh_machine_wide=ok` or `psh_machine_wide=incomplete`;
`install.sh` prints the same token with its `MACHINE-WIDE INCOMPLETE` block. `PSH_STRICT_MW=1`
makes the incomplete case exit 4. Prose changes; this does not.

## Gotchas that have bitten twice

- `neighbour_record()` (pre-`GLOBAL_DIR`) adopts a **sibling** project's record
  (`dirname "$PWD"/*/.psh/keys.json`), so a "fresh" install next to an old one adopts instead of
  minting. Test in a tree with no siblings, or set `GLOBAL_DIR`.
- Never `cp -R "$SKILL_DIR/."` without checking `$SKILL_DIR` resolves to the skill: an empty
  source becomes `cp -R //.` and copies the filesystem. Both `setup.sh` and `install.sh` guard it.
- `resolve_psh_dir()` never climbs into `$HOME`: running the uninstaller from `$HOME` makes
  `PSH_DIR=$HOME/.psh`.
