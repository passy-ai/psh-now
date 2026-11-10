# AGENTS.md

Instructions for coding agents working in **this** repo (the psh.now skill
package, a GitHub repo). For the skill's own instructions to agents, see
`SKILL.md`.

## What this repo is

The publishable skill package for psh.now. It is **not** the service. The service (server,
database, dashboard) is open source and lives in `passy-ai/psh-now`; this repository carries only
the skill.

## Rules

- Keep `SKILL.md` focused, in the here.now style: docs-first, one clear
  behavioural rule, one tool, one boolean. Write plainly and never use em dashes
  (use a hyphen). Do not add select/input, polling
  transports, or policy engines.
- **Only the skill is published.** `scripts/sync-skill-repo.sh` copies SKILL.md, README.md,
  LICENSE, install.sh, package.json, report.txt, .gitignore, host and scripts/*.sh into
  `skill-repo/`, and deletes anything else that would otherwise go public. The service, the UI
  and the internal notes live outside this repository (it also
  scans tree and history for secrets) and flip with `sh scripts/skill-visibility.sh public|private`.
- **Visibility is a switch, not a sentence.** The copy says "GitHub credentials only if that repo
  is private", so flipping never needs a text change.
- **A question is label-free.** What the human sees is one question line, a blank line, then
  one sentence saying exactly what you will do. Nothing is written in front of the first line:
  no `title:`, no `Question:` or `Answer:`, no `Recommended:` prefix, and no em dashes. A tap
  must need no follow-up. The card, the CLI and the answer text all keep this shape.
- The skill **is** the mechanism. It must make this unmissable: *if you are about
  to ask the user a question, do not end your turn with it - turn it into a
  yes/no on your recommended route and route it through psh.now.* Destructive
  actions are examples, not the definition.
- Store credentials in `<project>/.psh/keys.json` (outside the skill dir, so
  reinstalling the skill cannot wipe them), with the machine's account in
  `~/.psh/keys.json` as the fallback, like here.now's `~/.herenow/credentials`.
- `approved` stays a boolean, and `{"approved": true}` is only acted on when
  `status` is exactly `approved`. The human may instead type an **answer**
  (`status: "answered"`, with the text in `answer`): that is instruction, not
  approval, and it never stands in for `approved: true` where approval is
  required. Keep the "no fabricated approvals / no codes" rule, and keep the
  request a single yes/no - no menus, no option lists.
- Everything in the published package (`skill-repo/`) is **synced** from this
  tree by `scripts/sync-skill-repo.sh`. Edit the canonical `skills/psh-now/`
  files, never `skill-repo/` by hand.
- Keep the install shape identical to the ecosystem norm, as ONE pasteable command, and keep
  its trailing `-y`:
  `npx skills add passy-ai/psh-now-skill -g -y`
  Without `-y` the skills CLI waits on a prompt, installs nothing and exits 1 (measured
  2026-10-18, cold cache, no TTY). `-g` is the machine-wide copy into
  `~/.agents/skills/psh-now`; the line mints nothing, so `scripts/setup.sh` runs once after it
  to create `~/.psh/keys.json` and put `psh` on PATH. The `curl …/install.sh -o /tmp/psh-install.sh && bash /tmp/psh-install.sh` fallback
  needs no credentials and finishes the join in the same command when it is handed a channel
  link (`| bash`; the link travels in the sentence, never as an installer argument - that
  re-installs a machine that only needed to join). Never write an environment variable into a
  prompt a human is
  meant to paste. Only the docs show the combined install-and-join prompt.
- **A finished install is machine-wide**: the skill at
  `~/.agents/skills/psh-now` for every folder, a `psh` CLI on PATH, and one
  machine account record at `~/.psh/keys.json` (which keeps every project on ONE
  account). When a sandbox refuses those writes the run is **incomplete** and
  says so - `psh_machine_wide=incomplete` as setup.sh's last line (`MACHINE-WIDE
  INCOMPLETE` from install.sh; exit 4 with `PSH_STRICT_MW=1`). The way to finish
  it is ONE ask through psh.now, then a re-run with the permissions granted.
  Never describe a project-local install as machine-wide.

## Sync

From the service repo root:

```bash
scripts/sync-skill-repo.sh
```

which copies `skills/psh-now/{SKILL.md,README.md,SECURITY.md,AGENTS.md,LICENSE,report.txt}`,
the repo-root `install.sh`, `scripts/*.sh`, `assets/` and the plugin manifests into
`skill-repo/`, and writes `skill-repo/host`. `scripts/build-tarball.sh` then builds the
published archive from `skill-repo/`.
