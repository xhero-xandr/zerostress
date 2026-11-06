#!/usr/bin/env bash
# The real collector (spec 005) behind the real supervisor: real microVMs, real Chromium, a real public page.
# It lays the collector over a COPY of the installed image, swaps that copy in for the duration of the test and always
# puts the installed image back. Run as root on the host, from the working copy to test, with the supervisor service
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
art_event() { grep -A1 '^event: artifact' <<<"$1" | grep '^data:' | sed 's/^data: //'; }
fetch_art() { api -D "$3" -o "$4" "http://localhost/v1/runs/$1/artifacts/$2"; }   # id name header-file body-file
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

echo "== the screenshot reaches the host (agent hand-over, checked and stored by the supervisor)"
claim=$(grep -A1 '^event: evidence' <<<"$ev" | grep '"kind":"artifact"' | head -1)
art=$(art_event "$ev" | head -1)
check "the host published the file it fetched" "$art" '"saved":true'
name=$(field "$art" name)
check "named by 16 hex digits and .png" "$name" '^[0-9a-f]{16}\.png$'
check "the collector announced the same file" "$claim" "\"file\":\"$name\""
fetch_art "$id" "$name" /var/tmp/zs-art.hdr /var/tmp/zs-art.png
check "served with 200" "$(head -1 /var/tmp/zs-art.hdr)" ' 200'
check "served as image/png, no sniffing" "$(tr -d '\r' </var/tmp/zs-art.hdr)" 'Content-Type: image/png'
check "no content sniffing allowed" "$(cat /var/tmp/zs-art.hdr)" 'X-Content-Type-Options: nosniff'
check "it is a real PNG" "$(head -c 8 /var/tmp/zs-art.png | od -An -tx1 | tr -d ' \n')" '^89504e470d0a1a0a$'
check "the size is what the event says" "$(stat -c %s /var/tmp/zs-art.png)" "^$(grep -o '"bytes":[0-9]*' <<<"$art" | cut -d: -f2)$"
check "the hash is what the event says" "$(sha256sum /var/tmp/zs-art.png | cut -d' ' -f1)" "^$(field "$art" sha256)$"
check "the screenshot is not empty (more than 1 KiB)" "$(( $(stat -c %s /var/tmp/zs-art.png) > 1024 ))" '^1$'
check "an unknown name is 404" "$(api -o /dev/null -w '%{http_code}' "http://localhost/v1/runs/$id/artifacts/0000000000000000.png")" '^404$'
check "a path is 404" "$(api -o /dev/null -w '%{http_code}' "http://localhost/v1/runs/$id/artifacts/..%2F..%2Fetc%2Fpasswd")" '^404$'
check "another run's file is not served under this id" "$(api -o /dev/null -w '%{http_code}' "http://localhost/v1/runs/11111111-1111-1111-1111-111111111111/artifacts/$name")" '^404$'
rm -f /var/tmp/zs-art.png /var/tmp/zs-art.hdr
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
r=$(cmd "$id" '{"cmd":"screenshot","id":"s1"}')
check "screenshot accepted" "${r##* }" '^202$'
check "the collector answered ok" "$(wait_event "$id" '"command_id":"s1".*"status":"done"' 40 && echo yes)" '^yes$'
n=0; for _ in $(seq 20); do n=$(grep -c '^event: artifact' <<<"$(live_events "$id" 1)"); ((n >= 2)) && break; done
check "a second artifact reached the host during the session (two published)" "$n" '^[2-9]$'
dref=$(grep '"kind":"links"' <<<"$(live_events "$id" 2)" | tail -1 | grep -o '"ref":"[a-z0-9]*"' | head -1 | cut -d'"' -f4)
check "a link ref on the second page" "$dref" '^(f[0-9]+)?e[0-9]+$'
r=$(cmd "$id" "{\"cmd\":\"download\",\"id\":\"d1\",\"snap\":2,\"ref\":\"$dref\"}")
check "download is held for a human (202, awaiting_approval)" "$r" '"status":"awaiting_approval".* 202$'
sleep 1
check "nothing was fetched before the approval" "$(grep -c '"kind":"download"' <<<"$(live_events "$id" 1)")" '^0$'
sha=$(field "${r% *}" command_sha256)
check "the approval is accepted" "$(api -X POST "${JSON[@]}" -w ' %{http_code}' -d "{\"command_id\":\"d1\",\"command_sha256\":\"$sha\"}" "http://localhost/v1/runs/$id/approvals" | awk '{print $NF}')" '^202$'
check "the download ran in the guest" "$(wait_event "$id" '"command_id":"d1".*"status":"done"' 40 && echo yes)" '^yes$'
n=0; for _ in $(seq 20); do n=$(grep -c '^event: artifact' <<<"$(live_events "$id" 1)"); ((n >= 3)) && break; done
check "the downloaded file reached the host (three published)" "$n" '^[3-9]$'
bin=$(art_event "$(live_events "$id" 2)" | grep '\.bin"' | head -1)
check "published as a .bin the host measured" "$bin" '"saved":true.*"mime":"application/octet-stream"|"mime":"application/octet-stream".*"saved":true'
binname=$(field "$bin" name)
fetch_art "$id" "$binname" /var/tmp/zs-art.hdr /var/tmp/zs-art.bin
check "a download is served as an opaque octet-stream" "$(tr -d '\r' </var/tmp/zs-art.hdr)" 'Content-Type: application/octet-stream'
check "its hash matches the event" "$(sha256sum /var/tmp/zs-art.bin | cut -d' ' -f1)" "^$(field "$bin" sha256)$"
rm -f /var/tmp/zs-art.hdr /var/tmp/zs-art.bin
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
