#!/bin/sh
# Rebuild the notch if the source is newer, restart it, and say what is now running.
# Usage: tools/psh-notch/restart.sh
set -eu
cd "$(dirname "$0")"

if [ PSHNotch.swift -nt psh-notch ]; then
    echo "source is newer, rebuilding"
    swiftc -parse-as-library -swift-version 5 -O -o psh-notch PSHNotch.swift
fi

pkill -f psh-notch 2>/dev/null || true
sleep 1
before=$(pgrep -f psh-notch | wc -l | tr -d ' ')
echo "still running after kill: $before"
[ "$before" = "0" ] || { echo "something survived, killing by pid"; for pid in $(pgrep -f psh-notch); do kill -9 "$pid"; done; sleep 1; }

nohup ./psh-notch >/tmp/psh-notch.log 2>&1 &
sleep 4

echo "instances: $(pgrep -f psh-notch | wc -l | tr -d ' ')"
for pid in $(pgrep -f psh-notch); do ps -o pid=,lstart= -p "$pid" | sed 's/^/  pid/'; done
tail -1 /tmp/psh-notch.log | sed 's/^/  log: /'
[ -x /tmp/wherebar ] && /tmp/wherebar | grep window | sed 's/^/  /'
