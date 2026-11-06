#!/usr/bin/env bash
# The real collector (spec 005) in a real microVM, through the real agent and vsock, on a real public page.
# The installed base image already holds Playwright and Chromium; the collector itself is laid on top by the overlay.
# Run as root on the host, from the working copy to test.
# Usage: collector.sh [BASE_IMAGE AGENT_BIN]
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-vm.sh"
export COLLECTOR_ENTRY=$HERE/../../collector/collect.mjs
vm_boot collector "${1:-}" "${2:-}"

RID=3f1c2a64-8d0b-4c35-9a77-0b6f3a1e2d90
URL=https://example.com/
SCAN="{\"schema\":1,\"run_id\":\"$RID\",\"kind\":\"url\",\"url\":\"$URL\"}"
SESS="{\"schema\":1,\"run_id\":\"$RID\",\"kind\":\"url\",\"url\":\"$URL\",\"session\":{\"max_s\":120}}"
kind() { grep "\"kind\":\"$1\"" <<<"$2" | head -${3:-1}; }

echo "== one autonomous pass"
out=$(run "$SCAN" --timeout=60)
check "status ok" "$out" '"status":"ok"'
check "first event is the requested navigation" "$(head -1 <<<"$out")" '"kind":"nav".*"via":"requested"'
check "page title read in the guest" "$(kind page "$out")" '"title":"Example Domain"'
check "TLS details of the site" "$(kind tls "$out")" '"issuer":"[^"]+".*"protocol":"TLS'
check "snapshot with refs" "$(kind snapshot "$out")" '\[ref=e[0-9]+\]'
check "one link to another origin" "$(kind links "$out")" '"origin_differs":true'
check "screenshot saved to the artifact directory" "$(kind artifact "$out")" '"mime":"image/png".*"saved":true'
check "summary is the last evidence event" "$(grep '"type":"evidence"' <<<"$out" | tail -1)" '"kind":"summary".*"nav_error":null'
check "no error event" "$(grep -c '"kind":"error"' <<<"$out")" '^0$'
ref=$(kind links "$out" | grep -o '"ref":"[a-z0-9]*"' | head -1 | cut -d'"' -f4)
echo "link ref in the first snapshot: $ref"

echo "== a session: snapshot, screenshot, then follow the link (the page changes), back, close"
out=$(run "$SESS" --timeout=90 \
  '{"cmd":"snapshot","id":"c1"}' \
  '{"cmd":"screenshot","id":"c2"}' \
  "{\"cmd\":\"open_link\",\"id\":\"c3\",\"snap\":2,\"ref\":\"$ref\"}" \
  '{"cmd":"back","id":"c4"}' \
  '{"cmd":"close","id":"c5"}')
check "session_ready after the scan" "$out" '"kind":"session_ready"'
check "five commands answered" "$(grep -c '"kind":"cmd_result"' <<<"$out")" '^5$'
check "all five ok" "$(grep '"kind":"cmd_result"' <<<"$out" | grep -c '"ok":true')" '^5$'
check "open_link led to another page" "$(grep '"kind":"page"' <<<"$out" | tail -2 | head -1)" '"title":"Example Domains"'
check "back returned" "$(grep '"kind":"page"' <<<"$out" | tail -1)" '"title":"Example Domain"'
check "session ended with close" "$out" '"session_end":"close"'
check "status ok" "$out" '"status":"ok"'

echo "== refusals"
out=$(run "$SESS" --timeout=60 '{"cmd":"open_link","id":"r1","snap":9,"ref":"e1"}' '{"cmd":"eval","id":"r2"}' '{"cmd":"close","id":"r3"}')
check "stale snapshot refused" "$out" '"id":"r1","ok":false,"error":"stale_snapshot"'
check "unknown command refused by the agent or the collector" "$out" 'bad_command|"id":"r2","ok":false,"error":"unknown_command"'

echo "== a page that does not exist"
out=$(run "{\"schema\":1,\"run_id\":\"$RID\",\"kind\":\"url\",\"url\":\"https://no-such-host.invalid/\"}" --timeout=60)
check "name resolution failure is a result" "$out" '"nav_error":"ERR_NAME_NOT_RESOLVED"'
check "status ok" "$out" '"status":"ok"'

if [[ $fail != 0 ]]; then
  echo "== agent log from the guest console"
  grep -aE "job finished|client side|write failed|listening on|command|collector" "$D/serial.log" | tail -30
fi
[[ $fail == 0 ]] && echo "COLLECTOR OK" || echo "COLLECTOR FAILED"
exit $fail
