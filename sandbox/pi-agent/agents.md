# Agent rules

Workspace: dada

<!-- pshy:begin -->
## pshy approval (managed block)

This workspace uses [pshy](http://192.168.0.239:4321) to send agent actions to a
human supervisor's phone before they happen.

**Rule:** Before any destructive, irreversible, or production action — or any
time you need a human decision — route the request through pshy and wait for
approval. A request is a short **title** plus a **message** that can be a
command, a described action, or a question.

Run the check:

```bash
pshy ask "Restart the production API?" --title "Restart prod"
```

- Approval `true` -> proceed.
- Approval `false` (or a timeout) -> **do not proceed**. Explain what was
  blocked and ask the user for a safer alternative.

Always use `pshy ask` for commands like `rm -rf`, `--force`, `sudo`, force
pushes, dependency reinstalls, database changes, or anything touching prod.
<!-- pshy:end -->