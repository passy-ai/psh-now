#!/usr/bin/env sh
# psh.now - route a question to a human before you act or stall.
#
#   ./scripts/ask.sh "Title" "What you are about to do" [channel]
#
# Uses the channel key saved by ./scripts/setup.sh. Keys are looked up in the
# workspace first (`<project>/.psh/`), then the old machine-global `~/.psh/`.
# If no key exists, it mints an anonymous account and saves it.
# Prints the response JSON on stdout, e.g. {"approved":true}, progress on stderr.
#
# Options:
#   --client <name>   harness name for attribution (pi, claude-code, cursor, …)
#   --agent <name>    what the approval card shows as the asking agent
#
# Environment (all optional):
#   PSH_AGENT      same as --agent <name>; overrides detection
#   PSH_BASE_URL   host to call (default: baked in by the installer; PSH_HOST works too)
#   PSH_API_KEY    use this key instead of the saved channel key
#   PSH_HOME       where keys live (default: nearest ./.psh, walking up)
#   PSH_TIMEOUT_MS how long to wait for a human (default server-side)
#   PSH_SEND_CWD   set to 1 to include $PWD with the request
set -eu

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

resolve_psh_dir() {
  if [ -n "${PSH_HOME:-}" ]; then printf '%s' "$PSH_HOME"; return; fi
  dir="$PWD"
  while :; do
    [ -d "$dir/.psh" ] && { printf '%s' "$dir/.psh"; return; }
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done
  # Fall back to the legacy machine-global key store if it exists.
  [ -d "$HOME/.psh" ] && { printf '%s' "$HOME/.psh"; return; }
  printf '%s' "$PWD/.psh"
}
PSH_DIR="$(resolve_psh_dir)"
KEYS="$PSH_DIR/keys.json"

# One reader for the host, shared verbatim with status.sh and psh.sh. A
# project-local install writes it next to the keys (`.psh/host`); the skill
# folder carries it baked in at install time, as `host` (what the package
# ships) or `.host` (what an older installer wrote). Read both spellings.
read_host() {
  for f in "$@"; do
    [ -f "$f" ] || continue
    v="$(cat "$f" 2>/dev/null || true)"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 0
}
HOST="${PSH_BASE_URL:-${PSH_HOST:-$(read_host "$PSH_DIR/host" "$SKILL_DIR/host" "$SKILL_DIR/.host")}}"
HOST="${HOST:-https://psh.now}"
CLIENT=""

# Read a JSON string field from stdin without jq.
field() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Escape a string for a JSON value. Control characters count: a title or
# message with a raw newline, tab or CR (or any other C0 byte) would otherwise
# reach the wire unescaped and make the body invalid JSON.
esc() {
  printf '%s' "$1" |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' |
    awk '
      { if (n++) printf "\\n"
        s = $0
        out = ""
        for (i = 1; i <= length(s); i++) {
          c = substr(s, i, 1)
          rep = ""
          for (k = 0; k < 32; k++) if (c == sprintf("%c", k)) { rep = sprintf("\\u%04x", k); break }
          if (rep == "\\u0009") rep = "\\t"
          else if (rep == "\\u000a") rep = "\\n"
          else if (rep == "\\u000d") rep = "\\r"
          out = out (rep == "" ? c : rep)
        }
        printf "%s", out }'
}

# Best-effort name of the calling harness, shown on the approval card.
# PSH_AGENT and --agent override this; empty lets the host fall back to the
# request's cwd for a label.
detect_agent() {
  if [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]; then
    printf 'claude-code'
  elif [ -n "${CODEX_SANDBOX:-}" ] || [ -n "${CODEX_HOME:-}" ]; then
    printf 'codex'
  elif [ -n "${CURSOR_TRACE_ID:-}" ] || [ -n "${CURSOR_AGENT:-}" ]; then
    printf 'cursor'
  elif [ -n "${GEMINI_CLI:-}" ]; then
    printf 'gemini'
  elif [ -n "${DSH_WEB_URL:-}" ] || [ -n "${DSH_SHELL:-}" ]; then
    printf 'dsh'
  fi
}

# Return the channel key: env, this project's .psh/keys.json (machine-global
# ~/.psh/keys.json as fallback), skill .keys.json, or a
# freshly minted one.
api_key() {
  if [ -n "${PSH_API_KEY:-}" ]; then
    printf '%s' "$PSH_API_KEY"
    return
  fi
  for f in "$KEYS" "$SKILL_DIR/.keys.json"; do
    if [ -f "$f" ]; then
      saved=$(field channelKey <"$f")
      if [ -n "$saved" ]; then
        printf '%s' "$saved"
        return
      fi
    fi
  done

  if [ -n "${PSH_JOIN:-}" ]; then
    # Join an existing account instead of minting a new one.
    token=$(printf '%s' "$PSH_JOIN" | sed 's#.*/##')
    joined=$(curl -fsS -X POST "$HOST/api/v1/join/$token")
    mkdir -p "$PSH_DIR"
    printf '%s\n' "$joined" >"$KEYS"
    chmod 600 "$KEYS" 2>/dev/null || true
    printf '%s\n' "$HOST" >"$PSH_DIR/host"
    channel=$(printf '%s' "$joined" | field channelKey)
    {
      echo "psh.now: joined an existing account (no new account created)"
      echo "psh.now:   channel key $channel"
      echo "psh_result.auth_mode=joined"
    } >&2
    printf '%s' "$channel"
    return
  fi

  minted=$(curl -fsS -X POST "$HOST/api/v1/mint")
  mkdir -p "$PSH_DIR"
  printf '%s\n' "$minted" >"$KEYS"
  chmod 600 "$KEYS" 2>/dev/null || true
  printf '%s\n' "$HOST" >"$PSH_DIR/host"
  user=$(printf '%s' "$minted" | field userKey)
  # Field order in the mint response: documented `channelKey` first, the
  # undocumented `apiKey` alias second - accept either, so a response that
  # omits `apiKey` still works.
  channel=$(printf '%s' "$minted" | field channelKey)
  [ -n "$channel" ] || channel=$(printf '%s' "$minted" | field apiKey)
  claimurl=$(printf '%s' "$minted" | field claimUrl)
  {
    echo "psh.now: minted an anonymous workspace"
    echo "psh.now:   user key    $user"
    echo "psh.now:   channel key $channel"
    echo "psh.now:   sign in at  $HOST/app#key=$user"
    [ -n "$claimurl" ] && echo "psh.now:   claim for more requests: $claimurl"
    echo "psh_result.auth_mode=anonymous"
  } >&2
  printf '%s' "$channel"
}

# Parse --client/--agent (--flag name or --flag=name); the rest are positional
# title, message, channel. Iterating "$@" keeps quoted args intact.
TITLE=""
MESSAGE=""
CHANNEL=""
want_client=0
want_agent=0
for arg in "$@"; do
  if [ "$want_client" = 1 ]; then CLIENT="$arg"; want_client=0; continue; fi
  if [ "$want_agent" = 1 ]; then AGENT="$arg"; want_agent=0; continue; fi
  case "$arg" in
    --help | -h)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --client) want_client=1 ;;
    --client=*) CLIENT="${arg#--client=}" ;;
    --agent) want_agent=1 ;;
    --agent=*) AGENT="${arg#--agent=}" ;;
    *)
      if [ -z "$TITLE" ]; then TITLE="$arg"
      elif [ -z "$MESSAGE" ]; then MESSAGE="$arg"
      elif [ -z "$CHANNEL" ]; then CHANNEL="$arg"
      fi ;;
  esac
done

TITLE="${TITLE:-Approval request}"
MESSAGE="${MESSAGE:-May I proceed?}"
AGENT="${AGENT:-${PSH_AGENT:-$(detect_agent)}}"
KEY=$(api_key)

if [ -z "$KEY" ]; then
  echo '{"approved":false,"error":"could not obtain a key"}' >&2
  exit 1
fi

# The sign-in link handed to the human. `#key=` signs in a device that has no
# session yet - no email, no code. app.js refuses to switch an already
# signed-in browser, so this can never hijack the human's own account.
user=$(field userKey <"$KEYS" 2>/dev/null || true)
ACCESS="$HOST/app"
[ -n "$user" ] && ACCESS="$HOST/app#key=$user"

# Create the request without blocking, so it exists before we open the page.
BODY="{\"title\":\"$(esc "$TITLE")\",\"message\":\"$(esc "$MESSAGE")\",\"wait\":false"
[ -n "$CHANNEL" ] && BODY="$BODY,\"channel\":\"$(esc "$CHANNEL")\""
[ -n "$AGENT" ] && BODY="$BODY,\"agent\":\"$(esc "$AGENT")\""
[ -n "${PSH_TIMEOUT_MS:-}" ] && BODY="$BODY,\"expiresInMs\":$PSH_TIMEOUT_MS"
[ "${PSH_SEND_CWD:-0}" = "1" ] && BODY="$BODY,\"cwd\":\"$(esc "$PWD")\""
BODY="$BODY}"

set -- -sS -X POST "$HOST" -H "x-psh-key: $KEY" -H "Content-Type: application/json"
[ -n "$CLIENT" ] && set -- "$@" -H "X-Psh-Client: ${CLIENT}/ask-sh"

# Create the request. Capture the HTTP status so a bad key is reported once,
# clearly, instead of spamming curl errors at the caller.
raw=$(curl "$@" -w '\n%{http_code}' -d "$BODY" 2>/dev/null || true)
code=$(printf '%s' "$raw" | tail -n 1)
created=$(printf '%s' "$raw" | sed '$d')
if [ "$code" != "200" ]; then
  echo "psh.now: could not create the request (HTTP ${code:-000})." >&2
  [ -n "$created" ] && printf '%s\n' "$created" >&2
  exit 1
fi
poll=$(printf '%s' "$created" | field pollUrl)

# On the FIRST request, open the approval page now that there is something to
# approve. Opening at install time just shows an empty page that looks broken.
open_once() {
  if [ -n "${PSH_NO_OPEN:-}" ]; then return 0; fi
  if [ ! -f "$KEYS" ]; then return 0; fi
  # Open the dashboard WITH the account key: a device with no session lands
  # straight on the request instead of a login gate ("anonymous, no login").
  # The app only adopts this key when there is no live session to protect, so a
  # human who is already signed in keeps their own account.
  access="$ACCESS"
  opener=""
  if command -v open >/dev/null 2>&1; then opener=open
  elif command -v xdg-open >/dev/null 2>&1; then opener=xdg-open
  elif command -v wslview >/dev/null 2>&1; then opener=wslview
  fi
  if [ -z "$opener" ]; then return 0; fi
  # Open on every request, so the human is pulled back to the page.
  "$opener" "$access" >/dev/null 2>&1 &
}
open_once

# Poll until the human decides. Retry transient failures; on a hard auth error
# stop with ONE clear line instead of a stream of curl errors.
resp="$created"
attempts=0
while :; do
  [ -n "$poll" ] || break
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 300 ]; then
    echo "psh.now: gave up waiting after 300 polls." >&2
    break
  fi
  raw=$(curl -sS -w '\n%{http_code}' "${poll}?wait=30" -H "x-psh-key: $KEY" 2>/dev/null || true)
  code=$(printf '%s' "$raw" | tail -n 1)
  case "$code" in
    200)
      resp=$(printf '%s' "$raw" | sed '$d')
      [ "$(printf '%s' "$resp" | field status)" = "pending" ] || break
      ;;
    401|403)
      echo "psh.now: key rejected (HTTP $code) while waiting - the account may be gone or the key revoked. Re-run setup.sh." >&2
      break
      ;;
    404)
      echo "psh.now: the request no longer exists (HTTP 404)." >&2
      break
      ;;
    *)
      sleep 2
      ;;
  esac
done

echo "$resp"
boolfield() {
  sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*(true|false).*/\1/p' | head -n 1
}
echo "psh_result.host=$HOST" >&2
echo "psh_result.approved=$(printf '%s' "$resp" | boolfield approved)" >&2
status=$(printf '%s' "$resp" | field status)
[ -n "$status" ] && echo "psh_result.status=$status" >&2

# The human has three buttons now: Approve, Deny, and Answer. An answer is
# neither - it is free text ("use staging", "yes but not yet on prod") that the
# agent is expected to read and act on. Surface it plainly, on stderr, so it is
# impossible to miss in a scrollback.
answer=$(printf '%s' "$resp" | field answer)
if [ "$status" = "answered" ] || [ -n "$answer" ]; then
  echo "psh_result.answer=$answer" >&2
  echo "psh.now: the human ANSWERED instead of approving or denying:" >&2
  printf '  %s\n' "$answer" >&2
  echo "  → read it and follow it; do not treat it as a bare yes." >&2
fi
if [ "$(printf '%s' "$resp" | boolfield approved)" != "true" ] && [ "$status" != "answered" ] && printf '%s' "$created" | grep -q '"onlineDevices":0'; then
  echo "psh.now: no device is paired yet - open $ACCESS and the request is waiting there" >&2
fi
