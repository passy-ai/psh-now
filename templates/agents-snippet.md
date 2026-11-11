<!-- psh.now:begin -->
## Ask before you act

Some actions need a human. Before any destructive, irreversible, or production
action, deleting or overwriting files, `--force`, `sudo`, force-push, dropping
data, installing or upgrading dependencies, deploying, or spending money, ask
first:

```bash
curl -s -X POST https://psh.now \
  -H "x-psh-key: $PSH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"<short label>","message":"<what you are about to do>"}'
```

The key comes from the environment, never from this file, so this block is safe
to commit. Where the skill or the installer has run, `psh` is on PATH and reads
the key from `~/.psh/keys.json` (mode 0600) itself, so
`psh ask "<short label>" "<what you are about to do>"` is the same call with
nothing to export.

The response is `{"approved":true}` or `{"approved":false}`.

- `approved: true`  -> go ahead.
- `approved: false` (or no response) -> do not run it. Explain what was blocked
  and ask me for a safer alternative.

The first response includes a `connectionId`; pass it as `connection` on later
calls. A connection is named after the project so I can find it. Ask every
question through psh.now, never in the terminal.

Do not end your turn with a question you could ask here. Carry the task through
to completion; ask anything you need from me before you finish, so one trip to
my phone is enough.

Keep `title` under ~60 characters and `message` to one or two lines so it fits
on a phone.
<!-- psh.now:end -->
