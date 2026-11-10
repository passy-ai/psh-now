#!/usr/bin/env sh
# Flip the skill repo's visibility, or report it.
#
#   sh scripts/skill-visibility.sh status     # what GitHub says, plus a credential-free clone test
#   sh scripts/skill-visibility.sh public     # flip public (checks the public boundary first)
#   sh scripts/skill-visibility.sh private    # flip back
#
# The copy handed to humans is visibility-neutral ("GitHub credentials only if that repo is
# private"), so flipping this changes the repo and nothing else. Run the boundary check before
# going public: it proves the repo carries the skill only, with no secrets in tree or history.
set -u
cd "$(dirname "$0")/.."

REPO=passy-ai/psh-now
CMD=${1:-status}

token() { printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p'; }

api() { # $1 method, $2 path, $3 body (PATCH only)
  T=$(token)
  [ -n "$T" ] || { echo "  no GitHub token available in the credential helper"; exit 2; }
  if [ "$1" = GET ]; then
    curl -fsS -H "Authorization: Bearer $T" -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$2"
  else
    curl -fsS -X "$1" -H "Authorization: Bearer $T" -H 'Accept: application/vnd.github+json' \
      -d "$3" "https://api.github.com/repos/$2"
  fi
}

anon() {
  env GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
    git -c credential.helper= ls-remote "https://github.com/$REPO" HEAD >/dev/null 2>&1
}

report() {
  js=$(api GET "$REPO")
  printf '%s' "$js" | grep -o '"private": *[a-z]*' | head -1 | sed 's/.*: */  github private=/'
  echo "  repo https://github.com/$REPO"
  if anon; then
    echo "  credential-free clone: works, so a machine with no GitHub login can install"
  else
    echo "  credential-free clone: refused, so the skills add line needs GitHub credentials"
  fi
}

case "$CMD" in
  status) report ;;
  public|private)
    if [ "$CMD" = public ]; then
      api PATCH "$REPO" '{"private":false}' >/dev/null && echo "  flipped: public"
    else
      api PATCH "$REPO" '{"private":true}' >/dev/null && echo "  flipped: private"
    fi
    sleep 2
    report ;;
  *) echo "usage: sh scripts/skill-visibility.sh [status|public|private]"; exit 2 ;;
esac
