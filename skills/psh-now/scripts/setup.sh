#!/usr/bin/env sh
# psh.now setup - mint your user key + channel key, or attach to a channel.
#
#   ./scripts/setup.sh                 # mint a new (anonymous) account
#   ./scripts/setup.sh <url>           # join that channel link (the way the prompts hand it over)
#   ./scripts/setup.sh --join <url>    # the same thing, spelled out
#   ./scripts/setup.sh --uninstall     # remove the skill, the `psh` command, symlinks
#   ./scripts/setup.sh --help
#
# Safe to re-run: it reuses existing keys while the host still accepts them. A
# dead key (workspace deleted, key rotated) is replaced with a fresh anonymous
# account automatically; the old file is kept as keys.json.stale-<time>.
#
# Environment:
#   PSH_BASE_URL  host to call (default: baked in by the installer)
#   PSH_HOME      where keys live (default: the nearest ./.psh, walking up)
#   PSH_JOIN      same as --join <url>
#   PSH_FORCE=1   mint fresh keys even if some exist
#
# Keys are kept IN THE WORKSPACE (`<project>/.psh/`), not on the machine, so an
# agent never has to write outside its sandbox. Set PSH_HOME=~/.psh for the old
# machine-global behaviour.
set -eu

HELP=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --help | -h) HELP=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) UNINSTALL=1; PSH_PURGE=1 ;;
  esac
done
if [ "$HELP" = 1 ]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Where the skill may have been installed machine-wide (the copy that shows up
# in every later session's skill list), and the machine-global psh.now dir.
GLOBAL_DEST="$HOME/.agents/skills/psh-now"
GLOBAL_DIR="${GLOBAL_DIR:-$HOME/.psh}"   # overridable, e.g. CI or a test run

# Remove what an install created. Keys are the account identity, so they stay
# unless --purge was asked for explicitly.
uninstall() {
  echo "psh.now: removing the skill"
  if [ -f "$SKILL_DIR/.psh-bin" ]; then
    bin="$(cat "$SKILL_DIR/.psh-bin")"
    if [ -n "$bin" ] && [ -f "$bin" ] && grep -q "psh.now" "$bin" 2>/dev/null; then
      rm -f "$bin" && echo "psh.now: removed $bin"
    fi
  fi
  # Remove the `psh` command wherever we may have put it, but only our own file.
  for cand in "$HOME/.local/bin/psh" "$HOME/bin/psh" "$HOME/.bun/bin/psh" \
    /opt/homebrew/bin/psh /usr/local/bin/psh; do
    if [ -f "$cand" ] && grep -q "psh.now" "$cand" 2>/dev/null; then
      rm -f "$cand" && echo "psh.now: removed $cand"
    fi
  done
  for dir in \
    "$HOME/.agents/skills" \
    "$HOME/.claude/skills" \
    "$HOME/.hermes/skills" \
    "$HOME/.trae/skills" \
    "$HOME/.cursor/skills" \
    "$HOME/.config/opencode/skills"; do
    if [ -L "$dir/psh-now" ]; then
      rm -f "$dir/psh-now" && echo "psh.now: unlinked $dir/psh-now"
    fi
  done
  if [ -d "$GLOBAL_DEST" ]; then
    rm -rf "$GLOBAL_DEST" && echo "psh.now: removed $GLOBAL_DEST"
  fi
  # Only ever delete an installed copy, never the source tree this script may be
  # running from: the destinations all end in /.agents/skills/psh-now.
  case "$SKILL_DIR" in
    */.agents/skills/psh-now)
      if [ -d "$SKILL_DIR" ]; then
        rm -rf "$SKILL_DIR" && echo "psh.now: removed $SKILL_DIR"
      fi
      ;;
    *) echo "psh.now: keeping $SKILL_DIR (not an installed copy)" ;;
  esac
  if [ "${PSH_PURGE:-0}" = 1 ]; then
    rm -f "$KEYS" "$PSH_DIR/config.json" "$PSH_DIR/host" "$PSH_DIR/README.md" 2>/dev/null || true
    echo "psh.now: purged keys in $PSH_DIR"
  else
    echo "psh.now: keys kept in $PSH_DIR (pass --purge to delete them too)"
  fi
  echo "psh.now: uninstalled"
}

resolve_psh_dir() {
  if [ -n "${PSH_HOME:-}" ]; then printf '%s' "$PSH_HOME"; return; fi
  dir="$PWD"
  # Never climb into $HOME: ~/.psh is machine-global (read-only fallback), and
  # writing this project's identity there silently gave an unrelated project the
  # wrong account. Stop at the project root, or at $HOME, whichever comes first.
  # $HOME is checked BEFORE ~/.psh on purpose: with the checks the other way round,
  # a project under home with no .psh of its own (every real project, once a machine
  # account exists) resolved to ~/.psh and wrote its keys into the machine record -
  # observed 2026-10-17 on the native run: step 2's join left no project keys at all.
  while :; do
    [ "$dir" = "$HOME" ] && break
    # Never treat the filesystem root as a workspace root: an install run from / wrote
    # /.psh, and no project could find those keys again (found 2026-11-10 in a clean
    # container, where `docker exec` starts in /).
    if [ "$dir" != "/" ] && [ -d "$dir/.psh" ]; then printf '%s' "$dir/.psh"; return; fi
    [ "$dir" = "/" ] && break
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  # Nothing above us is a project. Started from / (a container's default workdir) that used
  # to become a workspace root, so the keys landed in /.psh: the machine record is the only
  # sane place for an install that is not inside a project.
  case "$PWD" in
    / | "") [ -n "$HOME" ] && { printf '%s' "$HOME/.psh"; return; } ;;
  esac
  printf '%s' "${PWD%/}/.psh"
}
PSH_DIR="$(resolve_psh_dir)"
KEYS="$PSH_DIR/keys.json"
HOST_FILE="$PSH_DIR/host"

if [ "$UNINSTALL" = 1 ]; then
  uninstall
  exit 0
fi

HOST="${PSH_BASE_URL:-$(cat "$HOST_FILE" 2>/dev/null || cat "$SKILL_DIR/host" 2>/dev/null || cat "$SKILL_DIR/.host" 2>/dev/null || true)}"
HOST="${HOST:-https://psh.now}"

field() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}
add_field() {
  # A merge can only substitute a field that exists. The machine record a project
  # adopts is written by whichever command touched it last, so it may lack
  # channelName/channelUrl (a join writes only what it has). Insert an empty field
  # before the closing brace so the substitution that follows always has a target.
  f="$1"; k="$2"
  if [ -f "$f" ] && ! grep -q "\"$k\"[[:space:]]*:" "$f" 2>/dev/null; then
    sed "s/}[[:space:]]*$/,\"$k\":\"\"}/" "$f" >"$f.addfield" && mv "$f.addfield" "$f"
  fi
  return 0
}

# Is a stored key still accepted by the host? Prints yes / no / unknown.
# Only a definitive refusal counts as dead - a network blip must never orphan a
# live account by triggering a re-mint.
key_state() {
  key="$1"
  [ -n "$key" ] || { printf 'unknown'; return; }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -H "x-psh-key: $key" "$HOST/api/v1/me" 2>/dev/null) || code="000"
  case "$code" in
    401|403) printf 'no' ;;
    000) printf 'unknown' ;;
    *) printf 'yes' ;;
  esac
}

# The keys.json of a sibling project that already knows this host, or nothing. Reads
# outside the workspace are not confined - only writes are - so when a sandbox refused
# to write the machine record ($HOME/.psh), the record a *sibling* project wrote is still
# adoptable. That is what keeps a new folder on the human's account without any
# machine-wide write at all. PSH_NO_ADOPT=1 turns it off.
neighbour_record() {
  parent="$(dirname "$PWD")"
  [ -d "$parent" ] || return 0
  n=0
  for cand in "$parent"/*/.psh/keys.json; do
    [ -f "$cand" ] || continue
    n=$((n + 1))
    [ "$n" -le 10 ] || break
    chost=$(field host <"$cand")
    [ -z "$chost" ] || [ "$chost" = "$HOST" ] || continue
    k=$(field userKey <"$cand")
    [ -n "$k" ] || k=$(field channelKey <"$cand")
    [ -n "$k" ] || continue
    if [ "$(key_state "$k")" = yes ]; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 0
}

# A `psh` that needs no PATH and no machine-wide write: this project's own
# .psh/bin/psh. A workspace sandbox always allows it, and "there is no psh command" was
# what agents kept reporting as an install failure (2026-10-17).
install_local_shim() {
  bindir="$PSH_DIR/bin"
  mkdir -p "$bindir" 2>/dev/null || return 0
  {
    printf '#!/usr/bin/env sh\n'
    printf '# psh.now project command - written by psh-now; safe to delete.\n'
    printf 'PSH_SKILL_DIR="%s"\n' "$SKILL_DIR"
    printf 'export PSH_SKILL_DIR\n'
    printf 'exec sh "%s/scripts/psh.sh" "$@"\n' "$SKILL_DIR"
  } >"$bindir/psh" 2>/dev/null || return 0
  chmod 755 "$bindir/psh" 2>/dev/null || true
  return 0
}

# The machine-wide pieces a finished install leaves behind: the skill copy every later
# session sees, the agent-dir symlinks, and a `psh` on PATH.
#
# install.sh does this on the curl route, but the package route only runs THIS script - so
# "I installed it and it didn't install globally" was true by construction (reported
# 2026-10-17). mw_done below only ever *checked* for these; now something creates them.
# Every write is best-effort: a sandbox that refuses ~/.agents must leave the project
# install intact and say so, never abort a signup.
# Which `psh` CLI is on this machine, if any? Location first, PATH last: `command -v` is a PATH
# test and reports "missing" for an installed CLI in a sandbox with a short PATH (2026-10-17).
mw_shim() {
  for cand in "$HOME/.local/bin/psh" "$HOME/bin/psh" "$HOME/.bun/bin/psh" /usr/local/bin/psh /opt/homebrew/bin/psh; do
    if [ -f "$cand" ] && grep -q "psh.now" "$cand" 2>/dev/null; then printf '%s\n' "$cand"; return 0; fi
  done
  command -v psh 2>/dev/null || return 1
}

# The three pieces a machine-wide install needs, by existence - never by whether this run wrote.
mw_present() {
  [ -d "${GLOBAL_DEST:-$HOME/.agents/skills/psh-now}" ] || return 1
  [ -f "$GLOBAL_DIR/keys.json" ] || return 1
  mw_shim >/dev/null 2>&1
}

install_machine_wide() {
  [ "${PSH_NO_GLOBAL:-0}" = 1 ] && return 0
  # Never copy from an unresolved source. Run from outside the skill layout (a script
  # copied to /tmp, a wrapper that does not export PSH_SKILL_DIR), $SKILL_DIR is empty
  # and the copy becomes `cp -R //. <dest>` - which starts copying the whole
  # filesystem (hit for real on 2026-10-17: 53 GB into a temp HOME before it was
  # killed). An empty source is a "cannot do it", never a "copy everything".
  if [ -z "$SKILL_DIR" ] || [ ! -f "$SKILL_DIR/SKILL.md" ]; then
    MW_REFUSED=1
    echo "psh.now: machine-wide skill skipped - cannot resolve the skill folder (PSH_SKILL_DIR)" >&2
    return 0
  fi
  if [ "$SKILL_DIR" != "$GLOBAL_DEST" ]; then
    if mkdir -p "$GLOBAL_DEST" 2>/dev/null; then
      # Real files, not a symlink: a link into a project dangles the moment that project
      # is deleted, and a dangling "installed" skill is worse than none. Re-copying also
      # refreshes a machine-wide copy left behind by an older version of the skill.
      cp -R "$SKILL_DIR/." "$GLOBAL_DEST/" 2>/dev/null || true
      echo "psh.now: also installed machine-wide: $GLOBAL_DEST" >&2
    else
      MW_REFUSED=1
      echo "psh.now: machine-wide skill refused - cannot write $GLOBAL_DEST" >&2
    fi
  fi

  # Harnesses that keep their own skills directory get a link to the machine-wide copy.
  for dir in \
    "$HOME/.claude/skills" \
    "$HOME/.hermes/skills" \
    "$HOME/.trae/skills" \
    "$HOME/.cursor/skills" \
    "$HOME/.config/opencode/skills"; do
    [ -d "$dir" ] || continue
    ln -sfn "$GLOBAL_DEST" "$dir/psh-now" 2>/dev/null || true
  done

  # A `psh` on PATH: the first thing an agent tries. Never hijack a foreign `psh`.
  #   pass 1 - an existing, writable *user* dir this shell can already see
  #   pass 2 - ~/.local/bin, created if needed: it is on a normal login PATH, and writing into a
  #            package manager's prefix (/opt/homebrew/bin) makes `brew doctor` grumble
  #   pass 3 - any existing writable dir on PATH, package manager or not
  shimdir=""
  if [ -n "${PSH_BIN_DIR:-}" ]; then
    mkdir -p "$PSH_BIN_DIR" 2>/dev/null && shimdir="$PSH_BIN_DIR"
  else
    for cand in "$HOME/.local/bin" "$HOME/bin" "$HOME/.bun/bin"; do
      case ":$PATH:" in *":$cand:"*) ;; *) continue ;; esac
      [ -d "$cand" ] && [ -w "$cand" ] || continue
      if [ -e "$cand/psh" ] && ! grep -q "psh.now" "$cand/psh" 2>/dev/null; then
        continue
      fi
      shimdir="$cand"
      break
    done
    if [ -z "$shimdir" ] && mkdir -p "$HOME/.local/bin" 2>/dev/null && [ -w "$HOME/.local/bin" ]; then
      if [ ! -e "$HOME/.local/bin/psh" ] || grep -q "psh.now" "$HOME/.local/bin/psh" 2>/dev/null; then
        shimdir="$HOME/.local/bin"
      fi
    fi
    if [ -z "$shimdir" ]; then
      for cand in /usr/local/bin /opt/homebrew/bin; do
        case ":$PATH:" in *":$cand:"*) ;; *) continue ;; esac
        [ -d "$cand" ] && [ -w "$cand" ] || continue
        if [ -e "$cand/psh" ] && ! grep -q "psh.now" "$cand/psh" 2>/dev/null; then
          continue
        fi
        shimdir="$cand"
        break
      done
    fi
  fi
  [ -n "$shimdir" ] || shimdir="$HOME/.local/bin"
  [ -d "$shimdir" ] || mkdir -p "$shimdir" 2>/dev/null || { MW_REFUSED=1; return 0; }
  if {
    printf '#!/usr/bin/env sh\n'
    printf '# psh.now launcher - one offline screen: what this is, where it lives.\n'
    printf 'PSH_SKILL_DIR="%s"\n' "$GLOBAL_DEST"
    printf 'export PSH_SKILL_DIR\n'
    printf 'exec sh "%s/scripts/psh.sh" "$@"\n' "$GLOBAL_DEST"
  } >"$shimdir/psh" 2>/dev/null; then
    chmod 755 "$shimdir/psh" 2>/dev/null || true
    case ":$PATH:" in *":$shimdir:"*) ;; *) PSH_SHIM_NOT_ON_PATH=1 ;; esac
  else
    MW_REFUSED=1
  fi
  return 0
}

# Parse --join <url> (or --join=<url>), or a bare channel link as an argument: the prompts
# we hand humans say "join <link>", so the link travels as an argument, never as an env var.
JOIN="${PSH_JOIN:-}"
want_join=0
for arg in "$@"; do
  if [ "$want_join" = 1 ]; then JOIN="$arg"; want_join=0; continue; fi
  case "$arg" in
    --join) want_join=1 ;;
    --join=*) JOIN="${arg#--join=}" ;;
  */c/*) if [ -z "$JOIN" ]; then JOIN="$arg"; fi ;;
  esac
done

mkdir -p "$PSH_DIR"
printf '%s\n' "$HOST" >"$HOST_FILE"
# Keep the key directory out of git without touching the project's .gitignore.
[ -f "$PSH_DIR/.gitignore" ] || printf '*\n' >"$PSH_DIR/.gitignore"

if [ -n "$JOIN" ]; then
  # Join a channel/account: redeem the link for a channel key.
  token=$(printf '%s' "$JOIN" | sed 's#.*/##')
  tmp="$PSH_DIR/.join-response"
  code=$(curl -s -o "$tmp" -w '%{http_code}' -X POST "$HOST/api/v1/join/$token" 2>/dev/null) || code="000"
  case "$code" in
    200) resp=$(cat "$tmp") ;;
    410|404)
      rm -f "$tmp"
      echo "psh.now: that connect link is dead (HTTP $code) - it was already used, or the account it" >&2
      echo "psh.now: pointed at is gone. Do NOT quietly start a new account for the human: ask them" >&2
      echo "psh.now: for a current link (their dashboard: the channel's "Copy prompt for agent" button), or" >&2
      echo "psh.now: run plain ./scripts/setup.sh if they would rather begin a fresh one." >&2
      exit 3
      ;;
    000)
      rm -f "$tmp"
      echo "psh.now: could not reach $HOST to redeem the connect link" >&2
      exit 3
      ;;
    *)
      rm -f "$tmp"
      echo "psh.now: the connect link was refused (HTTP $code)" >&2
      exit 3
      ;;
  esac
  rm -f "$tmp"
  # A join writes a *project* file. If it landed on the machine-wide record instead
  # (which only happens when the folder IS $HOME - Fix G keeps projects out of ~/.psh),
  # it must not redefine which channel this machine's asks belong to: the account's own
  # channel survives the join, exactly as its login does.
  machine_channel=""
  if [ "$PSH_DIR" = "$GLOBAL_DIR" ] && [ -f "$KEYS" ]; then
    machine_channel=$(field channelKey <"$KEYS")
    machine_name=$(field channelName <"$KEYS")
    machine_url=$(field channelUrl <"$KEYS")
  fi
  # A join only returns an ask-only channel key. If this machine already owns an
  # account that the host still accepts, keep its account fields (the login)
  # instead of clobbering them - but drop them when the old key is dead, or the
  # project stays wedged on a credential that 401s.
  # Only a login that belongs to the account we just joined may be carried over, and only
  # fields the join does not itself return. Two bugs lived in the one-line version of this
  # (both hit on a real run, 2026-10-17): a throwaway account minted moments earlier by a
  # wrong install was kept and handed to the human as "your account", and channelUrl was
  # appended although the join response already carries one - two channelUrl keys in one
  # object, and JSON is last-wins, so every reader (psh included) then named the wrong
  # channel. The join's own fields always win.
  keep=""
  if [ -f "$KEYS" ]; then
    olduser=$(field userKey <"$KEYS")
    oldws=$(field workspaceId <"$KEYS")
    newws=$(printf '%s' "$resp" | field workspaceId)
    if [ -z "$olduser" ]; then
      : # nothing stored here that could be a login
    elif [ "$(key_state "$olduser")" = "no" ]; then
      echo "psh.now: the stored account key is no longer valid - not carrying it over" >&2
    elif [ -n "$oldws" ] && [ -n "$newws" ] && [ "$oldws" != "$newws" ]; then
      echo "psh.now: the login stored here belongs to another account ($oldws, not $newws) - dropped it" >&2
      echo "psh.now: the account you just joined is the one this project uses now" >&2
    else
      for f in userKey accessUrl claimUrl plan; do
        v=$(field "$f" <"$KEYS")
        [ -n "$v" ] && keep="$keep,\"$f\":\"$v\""
      done
    fi
  fi
  [ -n "$keep" ] && resp=$(printf '%s' "$resp" | sed "s|}\$|$keep}|")
  printf '%s\n' "$resp" >"$KEYS"
  chmod 600 "$KEYS"
  if [ -n "$machine_channel" ]; then
    add_field "$KEYS" channelKey
    add_field "$KEYS" channelName
    add_field "$KEYS" channelUrl
    awk -v ck="$machine_channel" -v cn="$machine_name" -v cu="$machine_url" '{
        if ($0 ~ /"channelKey"[[:space:]]*:/)  sub(/"channelKey"[[:space:]]*:[[:space:]]*"[^"]*"/,  "\"channelKey\":\"" ck "\"");
        if ($0 ~ /"channelName"[[:space:]]*:/) sub(/"channelName"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"channelName\":\"" cn "\"");
        if ($0 ~ /"channelUrl"[[:space:]]*:/)  sub(/"channelUrl"[[:space:]]*:[[:space:]]*"[^"]*"/,  "\"channelUrl\":\"" cu "\"");
        print
      }' "$KEYS" >"$KEYS.machine" && mv "$KEYS.machine" "$KEYS" && chmod 600 "$KEYS"
    echo "psh.now: kept this machine's own channel on the record in $GLOBAL_DIR" >&2
  fi
  echo "psh.now: joined an existing account (no new account created)" >&2
else
  # A key handed in by the environment (sandbox, CI, a machine with no shared HOME)
  # means we are already connected: write it as this project's channel key instead of
  # minting a second anonymous account. ask.sh and status.sh already honour it, so the
  # only thing missing was this - "install, then configure the key" used to mint a
  # throwaway account first, which is not the account the human watches.
  if [ -n "${PSH_API_KEY:-}" ] && [ ! -f "$KEYS" ]; then
    mkdir -p "$PSH_DIR" 2>/dev/null || true
    printf '{"channelKey":"%s","host":"%s"}\n' "$PSH_API_KEY" "$HOST" >"$KEYS" 2>/dev/null || true
    chmod 600 "$KEYS" 2>/dev/null || true
    # Ask the host which workspace this key belongs to. A record that cannot name its own
    # account made step 4's folder look like a *different* account than the one it is
    # actually asking on (found by the Docker four-step run, 2026-10-17). The key is
    # ask-only, so /me is the only question it can ask - and it is enough.
    if me_resp=$(curl -fsS --max-time 8 -H "x-psh-key: $PSH_API_KEY" "$HOST/api/v1/me" 2>/dev/null); then
      wsid=$(printf '%s' "$me_resp" | field id)
      pln=$(printf '%s' "$me_resp" | field plan)
      # /me names the channel a channel key is bound to. Without it this record held no
      # channelUrl, so the report's prompt offered a literal <channel-link> (same run).
      churl=$(printf '%s' "$me_resp" | field channelUrl)
      chname=$(printf '%s' "$me_resp" | field channelName)
      if [ -n "$wsid" ]; then
        add_field "$KEYS" workspaceId
        add_field "$KEYS" plan
        if [ -n "$churl" ]; then
          add_field "$KEYS" channelUrl
          add_field "$KEYS" channelName
        fi
        awk -v w="$wsid" -v p="${pln:-anonymous}" -v cu="$churl" -v cn="$chname" '{
            if ($0 ~ /"workspaceId"[[:space:]]*:/) sub(/"workspaceId"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"workspaceId\":\"" w "\"");
            if ($0 ~ /"plan"[[:space:]]*:/)        sub(/"plan"[[:space:]]*:[[:space:]]*"[^"]*"/,        "\"plan\":\"" p "\"");
            # channelUrl/channelName were inserted empty by add_field above; fill them.
            if (cu != "" && $0 ~ /"channelUrl"[[:space:]]*:/)  sub(/"channelUrl"[[:space:]]*:[[:space:]]*"[^"]*"/,  "\"channelUrl\":\"" cu "\"");
            if (cn != "" && $0 ~ /"channelName"[[:space:]]*:/) sub(/"channelName"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"channelName\":\"" cn "\"");
            print
          }' "$KEYS" >"$KEYS.enriched" && mv "$KEYS.enriched" "$KEYS" && chmod 600 "$KEYS" 2>/dev/null || true
        echo "psh.now: this folder asks on workspace $wsid (key from \$PSH_API_KEY)" >&2
      fi
    fi
    echo "psh.now: using the channel key from \$PSH_API_KEY (no account minted)" >&2
  fi
  # No keys in this project, but this machine may already have an account. Adopt
  # it (explicitly, and say so) rather than minting a second invisible one - the
  # whole point is that every project lands on the account the human watches.
  #
  # The machine record is the canonical source. When a sandbox refused to write one -
  # the boundary is this workspace, so ~/.psh cannot be created from in here - a
  # sibling project's record is just as good, and that is what lets the whole flow work
  # with nothing machine-wide at all.
  GLOBAL_DIR="${GLOBAL_DIR:-$HOME/.psh}"
  adopt_src=""
  if [ ! -f "$KEYS" ] && [ -z "${PSH_FORCE:-}" ]; then
    if [ -f "$GLOBAL_DIR/keys.json" ]; then
      adopt_src="$GLOBAL_DIR/keys.json"
    elif [ "${PSH_NO_ADOPT:-}" != "1" ]; then
      adopt_src="$(neighbour_record)"
    fi
  fi
  if [ -n "$adopt_src" ]; then
    gkey=$(field userKey <"$adopt_src")
    [ -n "$gkey" ] || gkey=$(field channelKey <"$adopt_src")
    if [ "$(key_state "$gkey")" = yes ]; then
      gw=$(field workspaceId <"$adopt_src")
      cp "$adopt_src" "$KEYS" && chmod 600 "$KEYS"
      echo "psh.now: adopting the account this machine already uses (found in $adopt_src, workspace $gw)" >&2
      echo "psh.now: (it stays the same account the human already watches - nothing new was minted)" >&2
      # Same account, but its own channel: no channel was given, and sharing the
      # first project's channel would leave the human unable to tell which agent is
      # asking. The account key stays untouched - only the channel changes.
      adopted_user=$(field userKey <"$KEYS")
      if [ -n "$adopted_user" ]; then
        tmp="$PSH_DIR/.channel-response"
        if curl -fsS -o "$tmp" -X POST "$HOST/api/v1/channels" \
             -H "x-psh-key: $adopted_user" -H 'content-type: application/json' \
             -d "{\"name\":\"$(basename "$PWD")\",\"agent\":\"$(basename "$PWD")\"}" 2>/dev/null; then
          newkey=$(field key <"$tmp")
          newurl=$(field url <"$tmp")
          newname=$(field name <"$tmp")
          if [ -n "$newkey" ]; then
            add_field "$KEYS" channelKey
            add_field "$KEYS" channelName
            add_field "$KEYS" channelUrl
            awk -v ck="$newkey" -v cn="${newname:-$(basename "$PWD")}" -v cu="$newurl" '{
                if ($0 ~ /"channelKey"[[:space:]]*:/)  sub(/"channelKey"[[:space:]]*:[[:space:]]*"[^"]*"/,  "\"channelKey\":\"" ck "\"");
                if ($0 ~ /"channelName"[[:space:]]*:/) sub(/"channelName"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"channelName\":\"" cn "\"");
                if ($0 ~ /"channelUrl"[[:space:]]*:/)  sub(/"channelUrl"[[:space:]]*:[[:space:]]*"[^"]*"/,  "\"channelUrl\":\"" cu "\"");
                print
              }' "$KEYS" >"$KEYS.newchannel" && mv "$KEYS.newchannel" "$KEYS" && chmod 600 "$KEYS"
            echo "psh.now: this project got its own channel on that account: $newname ($newkey)" >&2
          else
            echo "psh.now: note: could not create a channel for this project - sharing the account's existing one" >&2
          fi
          rm -f "$tmp"
        else
          rm -f "$tmp"
          echo "psh.now: note: could not create a channel for this project - sharing the account's existing one" >&2
        fi
      fi
    fi
  fi
  if [ -f "$KEYS" ] && [ -z "${PSH_FORCE:-}" ]; then
    # "Already set up" only holds while the host still accepts the stored key.
    olduser=$(field userKey <"$KEYS")
    [ -n "$olduser" ] || olduser=$(field channelKey <"$KEYS")
    case "$(key_state "$olduser")" in
      no)
        # Deleted workspace or rotated key: keep the old file for reference and
        # mint a fresh account instead of 401ing on every ask from now on.
        mv "$KEYS" "$KEYS.stale-$(date +%s)" 2>/dev/null || rm -f "$KEYS"
        echo "psh.now: the stored key is no longer valid - minting a fresh workspace" >&2
        echo "psh.now: the account you reported earlier is void; hand the human the report below" >&2
        resp=$(curl -fsS -X POST "$HOST/api/v1/mint")
        printf '%s\n' "$resp" >"$KEYS"
        chmod 600 "$KEYS"
        ;;
      unknown)
        echo "psh.now: could not reach $HOST to check the stored key - keeping it" >&2
        ;;
      *)
        echo "psh.now: already set up ($KEYS)" >&2
        ;;
    esac
  else
    resp=$(curl -fsS -X POST "$HOST/api/v1/mint")
    printf '%s\n' "$resp" >"$KEYS"
    chmod 600 "$KEYS"
    echo "psh.now: minted a new (anonymous) workspace" >&2
  fi
fi

user=$(field userKey <"$KEYS")
channel=$(field channelKey <"$KEYS")

workspace=$(field workspaceId <"$KEYS")
claimurl=$(field claimUrl <"$KEYS")

# A `psh` command that always exists: this project's own copy. A workspace sandbox
# refuses ~/.local/bin, and "there is no psh command" was repeatedly reported as the
# install having failed (2026-10-17), so never leave a folder without one.
install_local_shim || true
rel="${PSH_DIR#"$PWD"/}"
case "$PSH_DIR" in
  "$PWD"/*) psh_cmd="./$rel/bin/psh" ;;
  *) psh_cmd="$PSH_DIR/bin/psh" ;;
esac

# Rewrite keys.json without fields this version knows to be dead. A leftover
# field (joinUrl, say) is not harmless: an agent reads it, believes it, and hands
# the human a link that no longer works. It is a DENY-list on purpose - an
# allow-list silently drops any field a new host adds, which is worse than the
# stale field it removes.
prune_keys() {
  [ -f "$KEYS" ] || return 0
  dead="joinUrl joinURL join_url joinToken joinTokens joinLinks inviteUrl invite_url"
  pairs_before=$(grep -o '"[A-Za-z0-9_]*"[[:space:]]*:' "$KEYS" 2>/dev/null | wc -l | tr -d ' ')
  tmp="$KEYS.pruned"
  if awk '
    BEGIN { printf "{\n"; n = 0; dead = " joinUrl joinURL join_url joinToken joinTokens joinLinks inviteUrl invite_url " }
    {
      line = $0
      # A value may be a string, null, a number or a boolean: copy whatever kind
      # it is verbatim, so nothing is lost just for not being a quoted string.
      while (match(line, /"[A-Za-z0-9_]+"[ \t]*:[ \t]*("[^"]*"|null|true|false|-?[0-9][0-9.]*)/)) {
        pair = substr(line, RSTART, RLENGTH); line = substr(line, RSTART + RLENGTH)
        split(pair, a, "\"")
        key = a[2]
        val = pair
        sub(/^"[A-Za-z0-9_]+"[ \t]*:[ \t]*/, "", val)
        if (index(dead, " " key " ") == 0 && !(key in seen)) {
          seen[key] = 1
          if (n++) printf ",\n"
          printf "  \"%s\": %s", key, val
        }
      }
    }
    END { printf "\n}\n" }' "$KEYS" >"$tmp" 2>/dev/null; then
    pairs_after=$(grep -o '"[A-Za-z0-9_]*"[[:space:]]*:' "$tmp" 2>/dev/null | wc -l | tr -d ' ')
    # Which dead fields are actually present? Only those may disappear.
    dropped=""
    dropped_n=0
    for k in $dead; do
      if grep -q "\"$k\"[[:space:]]*:" "$KEYS" 2>/dev/null; then
        dropped="$dropped$k "
        dropped_n=$((dropped_n + 1))
      fi
    done
    # Refuse to replace a file with a shorter one: whatever this awk did not
    # understand (pretty-printed or nested JSON) must never be silently dropped.
    if [ -s "$tmp" ] && [ "$pairs_after" -ge "$((pairs_before - dropped_n))" ]; then
      mv "$tmp" "$KEYS"
      chmod 600 "$KEYS" 2>/dev/null || true
      if [ -n "$dropped" ]; then
        echo "psh.now: dropped stale field(s) from $KEYS: $dropped" >&2
      fi
    else
      rm -f "$tmp"
      echo "psh.now: left $KEYS as it was (unparsed fields: $pairs_before -> $pairs_after)" >&2
    fi
  else
    rm -f "$tmp"
  fi
  return 0
}
prune_keys

# Where this project keeps its keys, so the CLI can find a config next to them.
{
  printf '{\n'
  printf '  "baseUrl": "%s",\n' "$HOST"
  printf '  "apiKey": "%s",\n' "$channel"
  printf '  "workspaceId": "%s"\n' "$workspace"
  printf '}\n'
} >"$PSH_DIR/config.json"
chmod 600 "$PSH_DIR/config.json"

# The CLI reads ~/.psh/config.json by default. Only fill that in when it is
# missing or already points at this workspace - clobbering it silently is how a
# machine-global config ends up naming some other project's deleted workspace.
if [ "$PSH_DIR" != "$GLOBAL_DIR" ] && [ "${PSH_NO_GLOBAL_CONFIG:-0}" != 1 ]; then
  if mkdir -p "$GLOBAL_DIR" 2>/dev/null; then
    # Same redirect trap as the keys below: test before opening.
    gw=""
    if [ -f "$GLOBAL_DIR/config.json" ]; then
      gw="$(field workspaceId <"$GLOBAL_DIR/config.json" 2>/dev/null || true)"
    fi
    if [ ! -f "$GLOBAL_DIR/config.json" ] || [ "$gw" = "$workspace" ]; then
      cp "$PSH_DIR/config.json" "$GLOBAL_DIR/config.json" 2>/dev/null || true
      chmod 600 "$GLOBAL_DIR/config.json" 2>/dev/null || true
    fi
  fi
fi

# One screen, in the place an agent looks. The project copy names this
# workspace; the machine-global copy stays generic, so it can never tell another
# project that this one's account is its own.
readme_body() {
  cat <<EOF
# psh.now - what this directory is

psh.now lets an agent ask a human for approval instead of stalling. The agent
POSTs a short title + message; the human taps Approve or Deny on their phone.

  host          $HOST
  keys          $KEYS
  workspace     ${workspace:--}
  skill         $SKILL_DIR
  command       psh            (this screen)   psh doctor   psh status   psh ask "Title" "Message"
  how to ask    sh $SKILL_DIR/scripts/ask.sh "Title" "What you are about to do"
  attach more   dashboard → the channel card → "Copy prompt for agent"
  install       curl -fsSL $HOST/install.sh | sh
  docs          $HOST/setup.md

Rules: never start a second account for a human who already has one - if a
connect link is dead, say so in one line and ask for a current one. The account
key is for the dashboard only; keep it out of agent context.
EOF
}
readme_body >"$PSH_DIR/README.md" 2>/dev/null || true

# One account per machine, many projects. The first install records the account
# in ~/.psh/keys.json so later projects *join* it instead of minting a second
# invisible one; a machine-global copy that is live and different is never
# overwritten, only reported.
if [ "$PSH_DIR" != "$GLOBAL_DIR" ]; then
  # Guard the redirect: with an unwritable $HOME the *shell* reports a failed
  # `<"$GLOBAL_DIR/keys.json"` on its own stderr (`2>/dev/null` only covers the
  # command, not the redirection), and the agent reads that as "the keys file
  # errored" - reported as a genuine install failure on 2026-10-17.
  gkey=""
  if [ -f "$GLOBAL_DIR/keys.json" ]; then
    gkey="$(field channelKey <"$GLOBAL_DIR/keys.json" 2>/dev/null || true)"
  fi
  if [ -z "$gkey" ]; then
    if mkdir -p "$GLOBAL_DIR" 2>/dev/null && cp "$KEYS" "$GLOBAL_DIR/keys.json" 2>/dev/null; then
      chmod 600 "$GLOBAL_DIR/keys.json" 2>/dev/null || true
      printf '%s\n' "$HOST" >"$GLOBAL_DIR/host" 2>/dev/null || true
      echo "psh.now: recorded this machine's account in $GLOBAL_DIR/keys.json (workspace ${workspace:--})" >&2
      echo "psh.now: later projects on this machine will join this account instead of starting another" >&2
    fi
  elif [ "$(key_state "$gkey")" = no ]; then
    cp "$KEYS" "$GLOBAL_DIR/keys.json" 2>/dev/null && chmod 600 "$GLOBAL_DIR/keys.json" 2>/dev/null || true
    echo "psh.now: replaced the dead machine-global account in $GLOBAL_DIR with workspace ${workspace:--}" >&2
  else
    gws="$(field workspaceId <"$GLOBAL_DIR/keys.json")"
    if [ -n "$gws" ] && [ -n "$workspace" ] && [ "$gws" != "$workspace" ]; then
      echo "psh.now: note: this machine already has workspace $gws in $GLOBAL_DIR" >&2
      echo "psh.now: note: this project uses $workspace - if that is unexpected, the human" >&2
      echo "psh.now: note: should sign in to $HOST/app and keep one of them" >&2
    fi
  fi
fi

# Writing this README is the last thing setup does, and inside a workspace sandbox
# $HOME is exactly what is not writable. Under `set -e` a failed redirect aborted the
# whole script there - so a *successful* install reported exit 1, and agents told the
# human it had "partially failed". Keep the write inside the `if` condition (where
# `set -e` does not apply) and guard the directory first.
if [ "$PSH_DIR" != "$GLOBAL_DIR" ] && mkdir -p "$GLOBAL_DIR" 2>/dev/null && [ -w "$GLOBAL_DIR" ] \
   && cat >"$GLOBAL_DIR/README.md.tmp" 2>/dev/null <<EOF
# psh.now - this machine

psh.now is installed here. It lets an agent ask a human for approval, one tap.
If a human says "use psh now" / "ask me first", run this first:

  psh            # what it is, where the skill and keys are, what to do next
  psh doctor     # connectivity + credentials

  skill         ${GLOBAL_DEST:-$HOME/.agents/skills/psh-now}
  install       curl -fsSL $HOST/install.sh | sh
  docs          $HOST/setup.md

Keys are **per project**: each project keeps its own in <project>/.psh/keys.json,
so this directory holds no identity of its own. Don't mint a second account for
a human who already has one.
EOF
then
  if [ -s "$GLOBAL_DIR/README.md.tmp" ]; then
    mv "$GLOBAL_DIR/README.md.tmp" "$GLOBAL_DIR/README.md" 2>/dev/null || rm -f "$GLOBAL_DIR/README.md.tmp"
  fi
elif [ "$PSH_DIR" != "$GLOBAL_DIR" ]; then
  # This run could not write outside the workspace. Whether that matters depends on what is
  # ALREADY on the machine: the same output used to say "installed ✓ (machine-wide)" and
  # "THE MACHINE-WIDE COPY IS NOT" in one breath when the pieces existed but this run's
  # writes were refused (observed 2026-10-17, session a19dd6f2). Existence decides.
  if mw_present; then
    echo "psh.now: note: this run's write to $GLOBAL_DIR was refused - the sandbox boundary, not an error" >&2
    echo "psh.now: note: the machine-wide install is ALREADY present, so nothing is missing:" >&2
    echo "psh.now: note:   skill ~/.agents/skills/psh-now · CLI ${psh_cli:-psh} · record $GLOBAL_DIR/keys.json" >&2
    echo "psh.now: note: this project is connected and ready. No ask, no re-run needed." >&2
  else
    echo "psh.now: note: $GLOBAL_DIR is not writable from here - that is the sandbox boundary, not an error" >&2
    echo "psh.now: note: this project is installed, connected, and has its own command:" >&2
    echo "psh.now: note:   ./.psh/bin/psh status" >&2
    echo "psh.now: note: THIS PROJECT IS INSTALLED; THE MACHINE-WIDE COPY IS NOT - missing:" >&2
    [ -d "${GLOBAL_DEST:-$HOME/.agents/skills/psh-now}" ] || echo "psh.now: note:   ~/.agents/skills/psh-now   the skill every project sees" >&2
    [ -f "$GLOBAL_DIR/keys.json" ] || echo "psh.now: note:   $GLOBAL_DIR/keys.json   keeps every project on ONE account" >&2
    mw_shim >/dev/null 2>&1 || echo "psh.now: note:   ~/.local/bin/psh   the CLI, works from any folder" >&2
    echo "psh.now: note: That is a human step, not a permission to request. Say in one line that" >&2
    echo "psh.now: note: this install is project-local and unfinished, then route ONE ask -" >&2
    echo "psh.now: note: psh ask \"Install psh.now globally?\" \"The skill and the psh CLI are" >&2
    echo "psh.now: note: this project's only. Approve and I will install them machine-wide.\"" >&2
    echo "psh.now: note: - and re-run with the permissions granted. Or the human runs this in" >&2
    echo "psh.now: note: their own terminal, from this folder:" >&2
    echo "psh.now: note:   cd \"$(dirname "$PSH_DIR")\" && curl -fsSL $HOST/install.sh | sh" >&2
  fi
fi

accessurl=$(field accessUrl <"$KEYS")
[ -z "$accessurl" ] && [ -n "$user" ] && accessurl="$HOST/app?key=$user"

# Final report - one template that ships inside the skill (report.txt) and is rendered here.
# It used to be fetched from the host at run time, which meant the text that instructs an agent
# could change without a version bump and sat outside every digest (audit F7).
channelname=$(field channelName <"$KEYS")
channelurl=$(field channelUrl <"$KEYS")
cn="${channelname:-Default}"

# Machine-wide state, decided once and stated in the report. Three pieces are needed for a
# machine-wide install: the skill every project sees, the `psh` CLI on PATH, and the machine
# account record that keeps every project on ONE account. The CLI and the skill are equally
# important - the skill is what tells an agent to ask, the CLI is what it asks with - so a
# project-local install is never described as a complete one (2026-10-17).
install_machine_wide || true

mw_done=0
# Where did the CLI land, and can *this* shell see it? `command -v psh` is a PATH test: in a
# sandbox with a short PATH it reports "missing" for an installed CLI, and the human then reads a
# finished install as broken (observed 2026-10-17). Look in the usual locations first, then PATH.
psh_cli="$(mw_shim 2>/dev/null || true)"
[ -d "${GLOBAL_DEST:-$HOME/.agents/skills/psh-now}" ] && [ -n "$psh_cli" ] \
  && [ -f "$GLOBAL_DIR/keys.json" ] && mw_done=1
# Machine-readable detail on stderr, so stdout stays exactly one verdict line.
[ -n "$psh_cli" ] && echo "psh_cli=$psh_cli" >&2
if [ -n "$psh_cli" ]; then
  case ":$PATH:" in
    *":$(dirname "$psh_cli"):"*) echo "psh_cli_on_path=yes" >&2 ;;
    *) echo "psh_cli_on_path=no-this-shell (run $psh_cli, or add $(dirname "$psh_cli") to PATH)" >&2 ;;
  esac
fi
if [ "$mw_done" = 1 ]; then
  case ":$PATH:" in *":$(dirname "$psh_cli"):"*) psh_cmd="psh" ;; *) psh_cmd="$psh_cli" ;; esac
  commands_heading="## Commands, anywhere on this machine"
else
  commands_heading="## Commands, in this folder"
fi

if [ "$mw_done" = 1 ]; then
  install_state="**psh.now skill and CLI are installed on this machine.** All of it:

- **skill** - \`~/.agents/skills/psh-now\` - every project on this machine sees it
- **CLI** - \`$psh_cli\` - works from any folder (\`psh\` when your shell's PATH has that
  directory; a sandbox with a short PATH needs the absolute path), and \`psh doctor\` checks it
- **machine account record** - \`~/.psh/keys.json\` - every project here stays on this one account
- **this project** - \`$PSH_DIR\`"
  mw_note=""
else
  install_state="**psh.now is installed in this project only - the machine-wide install is NOT done.** Nothing was written outside the workspace:

- **this project** - \`$PSH_DIR\` - works right now, through \`$psh_cmd\`
- **skill every project sees** - \`~/.agents/skills/psh-now\` - skipped
- **CLI on PATH** - \`~/.local/bin/psh\` - skipped
- **machine account record** - \`~/.psh/keys.json\` - skipped

The run's last line says \`psh_machine_wide=incomplete\`. The section below is how to finish it -
one tap on your phone, or one line in your terminal."
  proj_dir="$(dirname "$PSH_DIR")"
  mw_note="## Finish the machine-wide install

Everything above already works in this project. Three pieces still need writes the sandbox does
not allow, so they are not installed yet:

1. the skill every project sees - \`~/.agents/skills/psh-now\`
2. the \`psh\` CLI on PATH - \`~/.local/bin/psh\`
3. the machine account record - \`~/.psh/keys.json\` - what keeps every project on this machine
   on the one account instead of minting a second, invisible one

**One tap.** Your agent sends one request, \u201cInstall psh.now globally?\u201d - approve it and the
agent re-runs the install with the permissions granted. That is the fastest way.

**Or one line**, in your own terminal, from this folder, so the same account is kept:

\`\`\`bash
cd \"$proj_dir\" && curl -fsSL $HOST/install.sh | sh
\`\`\`

Then all three should pass:

\`\`\`bash
test -f ~/.agents/skills/psh-now/SKILL.md && sh ~/.agents/skills/psh-now/scripts/psh.sh status
\`\`\`

(That checks the skill file, then runs the CLI by absolute path. \`command -v psh\` is only a PATH
test - in a shell with a short PATH it says "missing" for an installed CLI.)

Until you run it this is a **project-local** install, and the agent will say exactly that
rather than call it finished. Nothing else in this report changes when you do: same keys, same
account, same channel. If you would rather not, nothing here is blocked."

fi

# The claim section only exists for a brand-new anonymous login: the server hands back a
# claimUrl when it mints one, and never on a join or an already-registered account. So this
# is empty exactly when claiming is irrelevant ("if I do it on an existing account it
# doesn't need that").
claim_section=""
if [ -n "$claimurl" ]; then
  claim_section="## Claim your account - optional, new logins only

This login is anonymous. Claiming it lets you sign in with an emailed code instead of the key,
and keeps the fuller allowance - one lifetime allowance per workspace, no daily cap:

$claimurl

Already have a psh.now account? Then skip this - the agent joined the account you already use
and there is nothing to claim.

"
fi

# ONE prompt, handed to any agent - a chat or a sandbox (2026-10-17: there used to be two,
# a link one and a key one, and nobody could tell which to paste where). The key decides the
# account and the channel, so the key form works in both; the link is offered inside the same
# block for anyone who would rather join that way. Fenced, because prose loses the command.
# ONE prompt, handed to any agent - a chat or a sandbox. The link is the whole instruction:
# an installed agent joins it, an uninstalled one installs and then joins. No env vars, no key
# in the text, and the whole thing stays copyable in one go.
cp="I'd like you to use psh.now and join this channel: ${channelurl:-<channel-link>}"

# The report template ships inside the skill (F7): the text that instructs an agent must be
# versioned with the skill and covered by its digest, not fetched at run time from the host,
# where it could change an agent's behaviour without any version bump. No network fallback:
# a missing template prints the thin summary below instead of executing remote instructions.
template=""
[ -n "${SKILL_DIR:-}" ] && [ -f "$SKILL_DIR/report.txt" ] && template=$(cat "$SKILL_DIR/report.txt")
# awk's gsub reads `&` in the *replacement* as "the matched text", so a value that
# contains `&&` came out as the placeholder doubled ({machine_wide_note}{machine_wide_note})
# - caught in the Docker lane on 2026-10-17, the day the note was added. Escape every
# value rather than banning `&` from the copy, so the next person cannot trip on it.
esc_repl() { printf '%s' "$1" | sed 's/&/\\&/g'; }
if [ -n "$user" ] && [ -n "$template" ]; then
  printf '%s\n' "$template" \
    | AK="$(esc_repl "$user")" AU="$(esc_repl "${accessurl:-$HOST/app}")" \
      CP="$(esc_repl "$cp")" MW="$(esc_repl "$mw_note")" \
      IS="$(esc_repl "$install_state")" CS="$(esc_repl "$claim_section")" \
      PS="$(esc_repl "$psh_cmd")" CH="$(esc_repl "$commands_heading")" \
      CK="$(esc_repl "${channel:--}")" CU="$(esc_repl "${claimurl:--}")" \
      DU="$(esc_repl "$HOST/docs")" awk '{
      gsub(/\{account_key\}/, ENVIRON["AK"]);
      gsub(/\{app_url\}/, ENVIRON["AU"]);
      gsub(/\{connect_prompt\}/, ENVIRON["CP"]);
      gsub(/\{commands_heading\}/, ENVIRON["CH"]);
      gsub(/\{machine_wide_note\}/, ENVIRON["MW"]);
      gsub(/\{install_state\}/, ENVIRON["IS"]);
      gsub(/\{claim_section\}/, ENVIRON["CS"]);
      gsub(/\{psh_command\}/, ENVIRON["PS"]);
      gsub(/\{channel_key\}/, ENVIRON["CK"]);
      gsub(/\{claim_url\}/, ENVIRON["CU"]);
      gsub(/\{docs_url\}/, ENVIRON["DU"]);
      print
    }'
else
  echo "psh.now: installed ✓ $([ "$mw_done" = 1 ] && echo "(machine-wide: skill + psh CLI + record)" || echo "(this project only - the machine-wide pieces were refused)")"
  echo "psh.now: account key   ${user:-<held by the account owner>}"
  echo "psh.now: channel key   ${channel:--}"
  echo "psh.now: ask with      $psh_cmd ask \"Title\" \"What you are about to do\""
  [ "$mw_done" = 1 ] || echo "psh.now: project-local install - the machine-wide copy is the human's line: cd \"$(dirname "$PSH_DIR")\" && curl -fsSL $HOST/install.sh | sh"
  echo "psh.now: open + approve ${accessurl:-$HOST/app}"
fi

# The machine-readable verdict, always the last line: a harness (or the skill's own flow) can
# branch on it without parsing prose. `PSH_STRICT_MW=1` turns "incomplete" into exit 4 so a
# pipeline cannot present a project-local install as a finished one (2026-10-18 audit, F6).
if [ "$mw_done" = 1 ]; then
  echo "psh_machine_wide=ok"
else
  echo "psh_machine_wide=incomplete"
  if [ "${PSH_STRICT_MW:-0}" = 1 ]; then
    echo "psh.now: PSH_STRICT_MW=1 - machine-wide install incomplete, exiting 4" >&2
    exit 4
  fi
fi
