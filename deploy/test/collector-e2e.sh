#!/usr/bin/env bash
# The real collector (spec 005) behind the real supervisor: real microVMs, real Chromium, a real public page.
# It lays the collector over a COPY of the installed image, swaps that copy in for the duration of the test and always
# puts the installed image back. Run as root on the host, after deploy/dev-sync.sh and with the supervisor service
# running; SUP_CONCURRENCY=2 and the default SUP_SESSION_SLOTS=1.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e.sh"

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMG=/opt/zerostress/images/guest-rootfs.ext4
BACKUP=/var/tmp/zs-image-backup.ext4
JSON=(-H 'content-type: application/json')

restore() {
  if [[ -f $BACKUP ]]; then mv -f "$BACKUP" "$IMG"; echo "installed image restored"; fi
}
trap restore EXIT

[[ -x $SRC/guest-image/agent/zerostress-agent ]] || { echo "build the agent first (guest-image/build-agent.sh)"; exit 1; }
cp --sparse=always "$IMG" "$BACKUP"
bash "$SRC/guest-image/apply-overlay.sh" "$IMG" "$SRC/guest-image/agent/zerostress-agent" "$SRC/collector/collect.mjs" | tail -1
echo "real collector laid over the installed image (temporarily)"

post_session() { api -X POST "${JSON[@]}" -d "{\"kind\":\"url\",\"url\":\"$1\",\"session\":$2}" http://localhost/v1/runs; }
cmd() { api -X POST "${JSON[@]}" -w ' %{http_code}' -d "$2" "http://localhost/v1/runs/$1/commands"; }
live_events() { curl -sS -N --max-time "${2:-1}" --unix-socket "$SOCK" "http://localhost/v1/runs/$1/events" 2>/dev/null || true; }
wait_event() { local end=$((SECONDS + $3)); while ((SECONDS < end)); do grep -qE "$2" <<<"$(live_events "$1" 1)" && return 0; done; return 1; }

echo "== controls"
check "control: wait_event can fail" "$(wait_event nonexistent 'x' 1 && echo yes || echo no)" '^no$'

echo "== a plain run"
id=$(post https://example.com/ | rid)
check "accepted" "$id" '^[0-9a-f-]{36}$'
check "finishes done" "$(wait_state "$id" '^(done|failed)$' 90)" '^done$'
ev=$(api "http://localhost/v1/runs/$id/events")
check "navigation recorded" "$ev" '"kind":"nav"'
check "page read in the guest" "$ev" '"title":"Example Domain"'
check "TLS evidence" "$ev" '"kind":"tls"'
check "forms evidence" "$ev" '"kind":"forms"'
check "links evidence" "$ev" '"kind":"links"'
check "screenshot reported as an artifact" "$ev" '"kind":"artifact".*"saved":true'
check "the collector's own summary arrived" "$ev" '"kind":"summary"'
check "final status ok" "$(view "$id")" '"reason":null|"state":"done"'
host_clean "plain run"

echo "== a session: scan, then commands through the supervisor, then close"
id=$(post_session https://example.com/ '{"idle_s":60,"max_s":120}' | rid)
check "reaches the session state" "$(wait_state "$id" '^session$' 60)" '^session$'
ev=$(live_events "$id" 2)
ref=$(grep '"kind":"links"' <<<"$ev" | grep -o '"ref":"[a-z0-9]*"' | head -1 | cut -d'"' -f4)
check "a link ref came with the scan" "$ref" '^e[0-9]+$'
r=$(cmd "$id" "{\"cmd\":\"open_link\",\"id\":\"o1\",\"snap\":1,\"ref\":\"$ref\"}")
check "open_link accepted" "${r##* }" '^202$'
check "the collector answered ok" "$(wait_event "$id" '"command_id":"o1".*"status":"done"' 40 && echo yes)" '^yes$'
check "the second page was read" "$(live_events "$id" 2)" '"title":"Example Domains"'
r=$(cmd "$id" '{"cmd":"download","id":"d1","snap":2,"ref":"e1"}')
check "download is held for a human (202, awaiting_approval)" "$r" '"status":"awaiting_approval".* 202$'
r=$(cmd "$id" '{"cmd":"close","id":"bye"}')
check "close accepted" "${r##* }" '^202$'
check "run finishes done" "$(wait_state "$id" '^(done|failed)$' 60)" '^done$'
host_clean "session"

echo "== two runs at once, one of them a dead address"
a=$(post https://example.com/ | rid)
b=$(post https://no-such-host.invalid/ | rid)
check "first done" "$(wait_state "$a" '^(done|failed)$' 120)" '^done$'
check "second done (a navigation error is a result)" "$(wait_state "$b" '^(done|failed)$' 120)" '^done$'
check "name resolution failure reported" "$(api "http://localhost/v1/runs/$b/events")" 'ERR_NAME_NOT_RESOLVED'
host_clean "two runs"

[[ $fail == 0 ]] && echo "COLLECTOR E2E OK" || echo "COLLECTOR E2E FAILED"
exit $fail
