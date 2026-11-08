#!/usr/bin/env bash
# Shared by the supervisor end-to-end tests: API helpers over the Unix socket, waiting, PASS/FAIL accounting and the
# "nothing may be left on the host" check. Source it, do not run it. Run as root on the host.
# The caller sets `set -uo pipefail`.
SOCK=/zerostress/run/supervisor.sock
RUNS=/zerostress/data/supervisor/runs
fail=0

api() { curl -sS --max-time 30 --unix-socket "$SOCK" "$@"; }
post() { api -X POST -H 'content-type: application/json' -d "{\"kind\":\"url\",\"url\":\"$1\"}" http://localhost/v1/runs; }
rid() { grep -o '"run_id":"[^"]*"' | head -1 | cut -d'"' -f4; }
field() { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -1 | cut -d'"' -f4; }
view() { api "http://localhost/v1/runs/$1"; }
state() { field "$(view "$1")" state; }

wait_state() { # id regex seconds
  local end=$((SECONDS + $3)) s
  while ((SECONDS < end)); do s=$(state "$1"); [[ $s =~ $2 ]] && { echo "$s"; return 0; }; sleep 0.3; done
  echo "timeout (last state: $s)"; return 1
}
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1${2:+: $2}"; fail=1; }
check() { # name, actual, expected-regex
  [[ $2 =~ $3 ]] && ok "$1" || bad "$1" "got '$2', wanted /$3/"
}
host_clean() { # name
  sleep 1
  local p q d u
  p=$(pgrep -c firecracker); q=$(ip -br link | grep -c zstap); d=$(ls -A "$RUNS" | wc -l)
  u=$(systemctl list-units --all --no-legend --plain 'zsvm-*.service' | wc -l)
  [[ $p == 0 && $q == 0 && $d == 0 && $u == 0 ]] && ok "host clean after: $1" || bad "host clean after: $1" "firecracker=$p zstap=$q rundirs=$d vm-units=$u"
}

# ---- the test collector over the installed image -------------------------------------------------------------------
# Every microVM reads the installed image as it is, read-only (review D3): it is swapped by a rename within images/,
# never changed in place, so a VM that starts meanwhile gets one image or the other whole, and a running one keeps its.
IMG=/zerostress/images/guest-rootfs.ext4
BACKUP=/var/tmp/zs-image-backup.ext4
swap_in() { # file -> becomes the installed image
  cp --sparse=always "$1" "$IMG.swap" && mv -f "$IMG.swap" "$IMG"
}
lay_collector() { # collector entry -> a copy of the installed image with it, swapped in; restore_image undoes it
  local work
  work=$(mktemp -d)
  cp --sparse=always "$IMG" "$BACKUP"
  cp --sparse=always "$IMG" "$work/test.ext4"
  bash "$SRC/guest/image/apply-overlay.sh" "$work/test.ext4" "$SRC/build/guest-agent/zerostress-agent" "$1" | tail -1
  swap_in "$work/test.ext4"
  rm -rf "$work"
}
restore_image() {
  if [[ -f $BACKUP ]]; then swap_in "$BACKUP" && rm -f "$BACKUP" && echo "installed image restored"; fi
}
