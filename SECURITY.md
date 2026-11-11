# Security policy

## Reporting a vulnerability

Email **push@passy.ai** with `security` in the subject, and include what you found, the
instance or version, and the steps to reproduce it. If you prefer GitHub, open a private
advisory on [passy-ai/psh-now](https://github.com/passy-ai/psh-now/security/advisories/new).

Please do not open a public issue for anything that could be used against a running instance.

We aim to reply within three working days and to ship a fix or a mitigation within thirty days
for anything that affects confidentiality, approval integrity, or stored credentials. We will
credit you in the release notes unless you ask us not to.

## In scope

- The gateway in `src/` and the CLI in `cli/`.
- The dashboard and pairing flows in `public/`.
- The Notch app in `tools/psh-notch/`.
- The skill package in `skills/psh-now/`.

## Out of scope

- Denial of service from your own agent.
- Anything that requires an already compromised machine or database.
- Missing hardening headers on a self-hosted instance that has no TLS in front of it.
- Reports produced only by a scanner, with no demonstrated impact.

## What is worth attacking

The interesting surfaces, in order: one channel key reading or answering another workspace's
requests, a request being approved without a human, a webhook granting requests without a paid
event, and `PSH_SECRET` leaking through a stored value. If you find any of those, that is the
email to send.

## Supported versions

`main` is the supported version. Releases are tagged, and fixes land on `main` first. A
self-hosted instance is only as patched as the last time you pulled.
