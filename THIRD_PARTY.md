# Third party notices

psh.now is MIT licensed (see `LICENSE`). It ships or inlines the following work, which stays
under its own licence; MIT does not require a NOTICE file, but these notices are the right thing
to keep and the right thing to carry into any fork. Nothing here is modified in a way that changes its licence; if a file is
ever patched, note it in this file in the same commit.

## Bundled assets

| What | Where | Licence | Notice |
|---|---|---|---|
| Pickr (colour picker) | `public/vendor/pickr/` | MIT | Copyright (c) Simon Reinisch. Full text in `public/vendor/pickr/LICENSE` if present upstream; otherwise https://github.com/Simonwep/pickr/blob/master/LICENSE |
| Lucide icons | inlined as SVG paths in `public/app.js` (see the `ICONS` map) | ISC | Copyright (c) Lucide Contributors. The ISC text follows below. |
| Inter | `website/fonts/inter-latin.woff2` | SIL Open Font License 1.1 | Copyright (c) The Inter Project Authors, https://github.com/rsms/inter |
| Geist and Geist Mono | `website/fonts/geist-latin.woff2`, `website/fonts/geist-mono-latin.woff2` | SIL Open Font License 1.1 | Copyright (c) Vercel, https://github.com/vercel/geist-font |

The fonts are subset to latin and served from our own origin; they are not re-licensed, and the
OFL requires that they not be sold on their own, which we do not do.

## Dependencies

Runtime dependencies are declared in `package.json` and installed from npm, so their licences are
carried by their packages rather than copied here. The direct runtime set is small:

| Package | Licence |
|---|---|
| elysia | MIT |
| @elysiajs/cors, @elysiajs/swagger, @elysiajs/static | MIT |
| better-auth | MIT |
| drizzle-orm, drizzle-kit | Apache-2.0 |
| postgres (postgres.js) | Unlicense |
| nodemailer | MIT |
| zod | MIT |
| @scalar/api-reference (dev, for `/openapi`) | MIT |

`bun pm ls` (or `bun pm licenses ls`, depending on Bun version) prints the resolved set with
licences; a release should run it once and reconcile this table rather than trust it.

## Lucide, ISC

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee is hereby granted, provided that the above copyright notice and this permission
notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THIS SOFTWARE.
```

## What is not covered by this repository's licence

- The `psh.now` service, its data, and the accounts on it.
- The Notch app's signing identity and Apple Developer credentials.
- Any customer data, workspace keys or payment records.
