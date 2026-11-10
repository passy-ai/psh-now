# Self hosting

The guide people read is served by the app at **`/self-hosting`** (`public/self-hosting.html`),
linked from `/docs` and from the website. It is the one to keep correct, because it is the one
that ships.

This file is the repository side of the same job: what is required, what has been verified, and
the two things a hoster cannot guess from the page.

Self hosting is a supported path, and self hosters count as demand rather than lost sales. It is
not the same product as the hosted service: the hosted instance carries push notifications (an
Apple push key and a signed app), the signed Notch build, billing, backups, and someone watching
it. What you get here is the whole core, and you are the ops team.

## Required, or it does not start

| Variable | Why it is required | Failure mode without it |
|---|---|---|
| `PUBLIC_BASE_URL` | every pairing link, email and QR code is built from it | compose refuses to start |
| `PSH_SECRET` | encrypts recoverable agent keys at rest (`src/env.ts:29`) | compose refuses to start |
| `DATABASE_URL` | Postgres; compose derives it from `POSTGRES_*` | container exits |
| `MAIL_FROM` plus `SMTP_URL` or `RESEND_API_KEY` | email is the only sign-in | server runs, sign-in cannot deliver |

`PSH_SECRET` cannot be rotated in place: changing it makes every stored agent key
undecryptable. Back it up with the database, not separately.

## Verified on a clean machine (2026-11-03)

Run in this order against a throwaway Postgres (`initdb` on port 5433), not against the tunnel:

```
initdb, pg_ctl, createdb               ok
DATABASE_URL=… bun src/db/migrate.ts   17 tables, no manual steps
PORT=4400 bun src/index.ts             "mail: not configured (codes print here)"
GET /docs                              200
GET /self-hosting                      200
GET /api/v1/health                     {"ok":true}
POST /api/v1/auth/otp                  {"ok":true,"devCode":"…"}
POST /api/auth/sign-in/email-otp       200, session token
```

Mail was verified separately, against a local SMTP sink and a rejected Resend key:

```
SMTP transport       MAIL FROM, RCPT TO and the code observed on the wire
Resend, bad key      "Resend rejected the message (401): API key is invalid"
no transport         "Mail is not configured: set SMTP_URL and MAIL_FROM, or RESEND_API_KEY…"
```

Not yet verified: a real provider delivering to a real inbox, a TLS terminator other than the
tunnel, and an upgrade over an existing database with data in it. Those are tracked in
`CONTRIBUTING.md` and the issue tracker.

## Two things a hoster cannot guess

1. **Proxy timeouts.** An ask blocks until a human answers. Cloudflare cuts at 100s with a 524,
   nginx at 60s. `DEFAULT_TIMEOUT_MS` defaults to 90s so it sits under both.
2. **Database distance.** Every query is a round trip. A database reached over a tunnel costs
   0.5 to 1s per statement and made page loads take 19s here. Run Postgres next to the app.

## Our own deployment

The hosted instance runs at `https://psh.now` and deploys from this repository. Nothing in the
code assumes that hostname: every URL is built from `PUBLIC_BASE_URL`, so a hardcoded host is
a bug worth reporting.

`PUBLIC_BASE_URL` is also the canonical host. A request for HTML on any other hostname is
answered with a 301 to the same path there, and `/api/` is exempt so an agent can always reach
the API on the host it was configured with. Set it once, to the name you want indexed.
