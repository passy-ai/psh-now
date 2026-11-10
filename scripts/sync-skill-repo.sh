#!/usr/bin/env sh
# Copy the public skill from skills/psh-now/ into skill-repo/, and prune anything else: the
# published repo is the skill at work, not the service around it. No UI, no internal docs,
# nothing half-finished.
set -eu
cd "$(dirname "$0")/.."

SRC=skills/psh-now
DST=skill-repo
# Exactly what a working install needs, plus the license and the short public readme.
PUBLIC="SKILL.md README.md LICENSE package.json report.txt .gitignore"

for f in $PUBLIC; do
  cp "$SRC/$f" "$DST/$f"
done
# install.sh lives at the repo root, not inside the skill folder.
cp install.sh "$DST/install.sh"
mkdir -p "$DST/scripts"
for src in "$SRC"/scripts/*.sh; do
  name="$(basename "$src")"
  cp "$src" "$DST/scripts/$name"
  chmod +x "$DST/scripts/$name"
done
# The host file is a non-dotfile on purpose, so `npx skills add` copies it too.
if [ -f "$SRC/.host" ]; then
  cp "$SRC/.host" "$DST/host"
else
  printf '%s\n' 'https://psh.now' > "$DST/host"
fi
chmod +x "$DST/install.sh"

for path in $(cd "$DST" && ls -A | grep -v '^\.git$'); do
  case " $PUBLIC install.sh scripts host " in
    *" $path "*) ;;
    *) echo "sync-skill-repo: removing $path (not part of the public skill)"; rm -rf "$DST/$path" ;;
  esac
done
echo "synced $DST/ from $SRC/ + install.sh (SKILL.md, README.md, LICENSE, package.json, report.txt, .gitignore, host, scripts/*.sh)"
