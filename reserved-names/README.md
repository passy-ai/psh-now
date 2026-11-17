# Reserved npm names

These two directories are published to npm and contain no code. They exist so the
obvious names cannot be taken by someone else and used to impersonate psh.now.

`psh-now` is the name people guess. `psh-now-cli` is the name a CLI would take if we
ever ship one on npm, which we have not: the CLI installs with

```bash
curl -fsSL https://psh.now/install.sh | bash
```

Neither directory has a `bin`, so neither can shadow or pretend to be the real thing.
Both READMEs say where the real install is. Publishing them again after an edit is:

```bash
cd reserved-names/psh-now && npm publish
```
