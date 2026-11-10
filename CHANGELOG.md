# Changelog

Notable changes, newest first. The format follows [Keep a Changelog](https://keepachangelog.com),
and versions follow [Semantic Versioning](https://semver.org).

## 0.1.0

First public release. The gateway, the dashboard, the skill, and the Notch app, MIT licensed.

### What it does

- A blocking `POST` that holds until a human taps Approve or Deny, or answers in their own words.
- Channels: one page for every agent, with per-channel keys and a pairing flow.
- Realtime fan-out over WebSocket and Postgres `LISTEN/NOTIFY`, so several nodes agree.
- The dashboard as a zero-build PWA that installs to a home screen and receives push.
- The Notch app for macOS, so an approval can land in the menu bar.
- The installable skill, published separately as `passy-ai/psh-now-skill`.

### Self hosting

- `docker compose up` with Postgres, a migration on boot, and three required variables.
- `/self-hosting` on every instance, and `docs/self-hosting.md` in the repository.
- Sign-in mail over SMTP or Resend, with a clear 503 instead of a silent failure when neither is
  configured.

### Known gaps

- There are no unit tests yet. CI typechecks, migrates a clean Postgres, boots the server, probes
  it, and validates the compose file.
- The dashboard is not translated.
- Webhooks are designed but not implemented.
