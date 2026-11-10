#!/usr/bin/env sh
# Build the published artifact: public/psh-now.tar.gz.
#
#   sh scripts/build-tarball.sh
#
# Built from skill-repo/ — the exact bytes `npx skills add passy-ai/psh-now-skill -g -y` installs —
# so the audited artifact and the installed artifact are the same file, and the archive digest
# published at /.well-known/agent-skills/index.json covers the installer too (audit F5: the
# digest used to skip install.sh, the script that does the installing). Run
# scripts/sync-skill-repo.sh first: this refuses to build from a stale package.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/skill-repo"
OUT="$ROOT/public/psh-now.tar.gz"

[ -f "$SRC/SKILL.md" ] || { echo "build-tarball: run scripts/sync-skill-repo.sh first" >&2; exit 1; }
[ -f "$SRC/install.sh" ] || { echo "build-tarball: skill-repo/install.sh is missing" >&2; exit 1; }
[ -f "$SRC/report.txt" ] || { echo "build-tarball: skill-repo/report.txt is missing" >&2; exit 1; }

rm -f "$OUT"
# COPYFILE_DISABLE=1: no AppleDouble ._ entries inside the archive.
COPYFILE_DISABLE=1 tar czf "$OUT" -C "$SRC" \
  --exclude '.git' \
  --exclude '.DS_Store' \
  SKILL.md install.sh report.txt README.md LICENSE package.json host .gitignore scripts

bytes=$(wc -c <"$OUT" | tr -d ' ')
echo "build-tarball: $OUT ($bytes bytes, $(tar tzf "$OUT" | wc -l | tr -d ' ') entries)"
