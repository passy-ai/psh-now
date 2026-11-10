# Contributing

Thanks for looking. This is a small codebase on purpose, and the fastest way to get a change
merged is to keep it that way.

## Before you start

- Read [docs/how-it-works.md](docs/how-it-works.md) for the flow and
  [docs/self-hosting.md](docs/self-hosting.md) for how it runs.
- For anything larger than a bug fix, open an issue first. It is cheaper than a rejected pull
  request.
- Security issues do not go in issues. See [SECURITY.md](SECURITY.md).

## Setting up

```bash
bun install
cp .env.example .env          # defaults are enough for local work
bun run migrate               # needs a Postgres on DATABASE_URL
bun run dev                   # http://localhost:3000
bun run typecheck             # must pass before you open a PR
```

Local sign-in needs no mail provider: with `NODE_ENV` not set to production, the code prints to
the console and comes back in the API response.

## What a pull request needs

1. **It runs.** `bun run typecheck` passes, and the flow you touched works when you run it.
2. **A test, or a reason there is not one.** `bun test` must not regress. A bug fix without a
   test that fails before it is a bug fix we cannot keep fixed.
3. **A sentence of why.** Commit messages describe the change and the reason, not the file.
4. **No new dependency without a note.** Every dependency is a supply chain decision. Say what it
   buys and what happens without it.

## Style

- Comments explain why, not what. If the code needs a paragraph to justify a choice, that
  paragraph belongs above the line.
- No emoji in the source, the copy, or the commit messages.
- Copy is plain sentences. No em dashes or middots, no marketing register in a technical doc.
- Prefer deleting a line to adding a flag. This codebase has very few options on purpose; adding
  one means someone now has to support every combination.

## Commits and branches

- Branch from `main`, keep the branch short lived, squash when merging.
- One logical change per pull request. A rename mixed into a fix makes the fix unreviewable.

## Licence

Contributions are under the MIT licence in [LICENSE](LICENSE), and by opening a pull request you
agree they can be. There is no CLA.
