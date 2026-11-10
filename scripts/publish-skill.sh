#!/usr/bin/env sh
# Publish the skill package to its own public repo, which is what `npx skills add` reads.
#
#   sh scripts/publish-skill.sh "what changed"
#
# The canonical source stays in skills/psh-now/ (the server bakes its scripts into /ask.sh,
# /psh.sh and the tarball, so they have to live here). This copies exactly the public surface
# into skill-repo/ and pushes it to passy-ai/psh-now-skill, so someone who only wants the skill
# does not clone the whole service.
#
# Installed copies update with: npx -y skills update psh-now
set -eu

cd "$(dirname "$0")/.."
msg="${1:-skill package update}"

sh scripts/sync-skill-repo.sh
# Build the digest-covered artifact from the same package bytes we are about to commit, so the
# audit surface (the tarball in index.json) and the install surface stay identical (F5).
sh scripts/build-tarball.sh

cd skill-repo
if [ ! -d .git ]; then
  echo "publish-skill: skill-repo/ is not a git checkout — run:" >&2
  echo "  gh repo create passy-ai/psh-now-skill --public --source=. --push" >&2
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "publish-skill: nothing changed — the repo already matches skills/psh-now"
  exit 0
fi

git add -A
git commit -q -m "$msg"
git push -q origin HEAD:main
echo "publish-skill: pushed $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
echo "publish-skill: installed copies update with: npx -y skills update psh-now"
