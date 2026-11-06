#!/usr/bin/env bash
# End-to-end test of interactive sessions (spec 006, 3.7-3.8) on the installed supervisor service with real microVMs
# and the stub collector in session mode (deploy/test/stub-collector.mjs). Run as root on the host.
# Needs: deploy/steps/50-supervisor.sh done with supervisor v2, guest image installed with the current stub
# (guest/image/build.sh + install.sh), SUP_CONCURRENCY=2 and the default SUP_SESSION_SLOTS=1.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e.sh"

JSON=(-H 'content-type: application/json')
post_session() { # url [session-json]
  local s=${2:-'{}'}
  api -X POST "${JSON[@]}" -d "{\"kind\":\"url\",\"url\":\"$1\",\"session\":$s}" http://localhost/v1/runs
}
cmd() { api -X POST "${JSON[@]}" -w ' %{http_code}' -d "$2" "http://localhost/v1/runs/$1/commands"; }
approve() { api -X POST "${JSON[@]}" -w ' %{http_code}' -d "{\"command_id\":\"$2\",\"command_sha256\":\"$3\"}" "http://localhost/v1/runs/$1/approvals"; }
code_of() { echo "${1##* }"; }
sha_of() { field "$1" command_sha256; }
# The event stream of a live run never ends, so read it for a moment and keep what arrived.
live_events() { curl -sS -N --max-time "${2:-1}" --unix-socket "$SOCK" "http://localhost/v1/runs/$1/events" 2>/dev/null || true; }
wait_event() { # id regex seconds
  local end=$((SECONDS + $3))
  while ((SECONDS < end)); do grep -qE "$2" <<<"$(live_events "$1" 1)" && return 0; done
  return 1
}
statuses() { grep "\"command_id\":\"$2\"" <<<"$1" | grep -o '"status":"[a-z_]*"' | cut -d'"' -f4 | tr '\n' ' '; }
echoes() { grep -c '"kind":"echo"' <<<"$1"; }
close_run() { cmd "$1" '{"cmd":"close","id":"bye"}' >/dev/null; }

echo "== controls: the detectors of this test must be able to fail"
check "control: the echo counter is zero for text without echoes" "$(echoes 'event: evidence')" '^0$'
check "control: the echo counter sees an echo" "$(echoes '{"kind":"echo"}')" '^1$'
check "control: code_of takes the HTTP code" "$(code_of '{"a":1} 409')" '^409$'

echo "== service"
check "service active" "$(systemctl is-active zerostress-supervisor)" '^active$'
check "health reports session slots" "$(api http://localhost/v1/health)" '"sessions":\{"running":0,"limit":1\}'
check "database migrated: an old run list still answers" "$(api -o /dev/null -w '%{http_code}' http://localhost/v1/runs/00000000-0000-4000-8000-000000000000)" '^404$'

echo "== validation of the session field"
for s in '{"max_s":5}' '{"idle_s":999}' '{"x":1}' 'true' '"yes"'; do
  check "session $s rejected" "$(api -o /dev/null -w '%{http_code}' -X POST "${JSON[@]}" -d "{\"kind\":\"url\",\"url\":\"https://example.com/?stub=session\",\"session\":$s}" http://localhost/v1/runs)" '^400$'
done

echo "== a session: live evidence, safe commands, an error from the guest"
id=$(post_session 'https://example.com/?stub=session&n=1' '{"idle_s":60,"max_s":120}' | rid)
check "accepted" "$id" '^[0-9a-f-]{36}$'
check "reaches the session state" "$(wait_state "$id" '^session$' 30)" '^session$'
ev=$(live_events "$id" 2)
check "evidence is live: session_ready is visible while the run is alive" "$ev" '"kind":"session_ready"'
check "the state event says session" "$ev" '"state":"session"'
check "view shows the session limits" "$(view "$id")" '"session":\{"idle_s":60,"max_s":120\}'
check "health counts the running session" "$(api http://localhost/v1/health)" '"sessions":\{"running":1,"limit":1\}'
r=$(cmd "$id" '{"cmd":"scroll","id":"s1","dy":200}')
check "scroll accepted" "$(code_of "$r")" '^202$'
check "scroll reaches the guest as its canonical form" "$(wait_event "$id" '"raw":"\{\\"cmd\\":\\"scroll\\",\\"dy\\":200,\\"id\\":\\"s1\\"\}"' 10 && echo yes)" '^yes$'
check "scroll is done" "$(wait_event "$id" '"command_id":"s1".*"status":"done"' 10 && echo yes)" '^yes$'
r=$(cmd "$id" '{"cmd":"open_link","id":"o1","snap":1,"ref":"e999"}')
check "open_link accepted" "$(code_of "$r")" '^202$'
check "the guest's error code comes back on the command" "$(wait_event "$id" '"command_id":"o1".*"status":"error".*"error":"ref_not_found"|"command_id":"o1".*"error":"ref_not_found".*"status":"error"' 10 && echo yes)" '^yes$'
r=$(cmd "$id" '{"cmd":"wait","id":"w1","ms":300}')
check "wait accepted" "$(code_of "$r")" '^202$'

echo "== malformed commands never reach the guest"
before=$(echoes "$(live_events "$id" 1)")
for body in '{"cmd":"eval","id":"x1"}' '{"cmd":"scroll","id":"x2","dy":99999}' '{"cmd":"scroll","id":"x3"}' '{"cmd":"snapshot","id":"x4","extra":1}' '[]' 'not json' '{"cmd":"back","id":"bad id"}'; do
  check "400 for $body" "$(code_of "$(cmd "$id" "$body")")" '^400$'
done
check "duplicate id refused" "$(code_of "$(cmd "$id" '{"cmd":"snapshot","id":"s1"}')")" '^409$'
sleep 1
check "no new echo in the guest" "$(echoes "$(live_events "$id" 1)")" "^$before\$"

echo "== risky commands wait for a human, bound to the hash of their exact content"
r=$(cmd "$id" '{"cmd":"download","id":"dl","snap":1,"ref":"e2"}')
check "download is held" "$r" '"status":"awaiting_approval".* 202$'
sha=$(sha_of "$r")
check "hash is a sha256" "$sha" '^[0-9a-f]{64}$'
sleep 1
check "nothing about dl reached the guest" "$(grep -c '"kind":"echo","id":"dl"' <<<"$(live_events "$id" 1)")" '^0$'
check "a wrong hash is refused (409)" "$(code_of "$(approve "$id" dl "$(printf 'f%.0s' {1..64})")")" '^409$'
check "a malformed approval is refused (400)" "$(code_of "$(api -X POST "${JSON[@]}" -w ' %{http_code}' -d '{"command_id":"dl"}' "http://localhost/v1/runs/$id/approvals")")" '^400$'
check "an unknown command is 404" "$(code_of "$(approve "$id" nope "$sha")")" '^404$'
sleep 1
check "still nothing in the guest after the refused approvals" "$(grep -c '"kind":"echo","id":"dl"' <<<"$(live_events "$id" 1)")" '^0$'
check "the right hash is accepted" "$(code_of "$(approve "$id" dl "$sha")")" '^202$'
check "now the command arrives, exactly as hashed" "$(wait_event "$id" '"raw":"\{\\"cmd\\":\\"download\\",\\"id\\":\\"dl\\",\\"ref\\":\\"e2\\",\\"snap\\":1\}"' 10 && echo yes)" '^yes$'
check "and completes" "$(wait_event "$id" '"command_id":"dl".*"status":"done"' 10 && echo yes)" '^yes$'
check "a second approval of the same command is refused (409)" "$(code_of "$(approve "$id" dl "$sha")")" '^409$'
dl_echoes=$(grep -c '"kind":"echo","id":"dl"' <<<"$(live_events "$id" 1)")
check "the guest got it exactly once" "$dl_echoes" '^1$'
r=$(cmd "$id" '{"cmd":"submit_form","id":"sf","snap":1,"form":"e4","values":{"e5":"SECRETVALUE123"}}')
shaf=$(sha_of "$r")
check "another risky command: the hash of dl does not approve it" "$(code_of "$(approve "$id" sf "$sha")")" '^409$'
check "its own hash does" "$(code_of "$(approve "$id" sf "$shaf")")" '^202$'
r=$(cmd "$id" '{"cmd":"download","id":"dl2","snap":1,"ref":"e7"}')
check "rejecting a waiting command" "$(code_of "$(api -X DELETE -w ' %{http_code}' "http://localhost/v1/runs/$id/commands/dl2")")" '^202$'
check "a rejected command cannot be approved" "$(code_of "$(approve "$id" dl2 "$(sha_of "$r")")")" '^409$'

echo "== closing"
check "close accepted" "$(code_of "$(cmd "$id" '{"cmd":"close","id":"bye"}')")" '^202$'
check "run ends done" "$(wait_state "$id" '^(done|failed)$' 20)" '^done$'
check "agent status ok" "$(field "$(view "$id")" agent_status)" '^ok$'
final=$(api --max-time 10 "http://localhost/v1/runs/$id/events")
check "dl: accepted, held, approved, sent, done" "$(statuses "$final" dl)" '^accepted awaiting_approval approved sent done $'
check "dl2: accepted, held, rejected" "$(statuses "$final" dl2)" '^accepted awaiting_approval rejected $'
check "bye: accepted, sent, done" "$(statuses "$final" bye)" '^accepted sent done $'
check "states in order include session" "$(grep -o '"state":"[a-z]*"' <<<"$final" | cut -d'"' -f4 | awk '!s[$0]++' | tr '\n' ' ')" '^queued preparing booting running session destroying done $'
check "after the end, commands get 409" "$(code_of "$(cmd "$id" '{"cmd":"snapshot","id":"late"}')")" '^409$'
check "after the end, approvals get 409" "$(code_of "$(approve "$id" sf "$shaf")")" '^409$'
host_clean "session closed by the client"

echo "== commands for runs that are not sessions"
plain=$(post 'https://example.com/?stub=sleep&ms=20000' | rid)
check "plain run reaches running" "$(wait_state "$plain" '^running$' 30)" '^running$'
check "commands to a one-shot run get 409" "$(code_of "$(cmd "$plain" '{"cmd":"snapshot","id":"a"}')")" '^409$'
check "commands to an unknown run get 404" "$(code_of "$(cmd 00000000-0000-4000-8000-000000000000 '{"cmd":"snapshot","id":"a"}')")" '^404$'
api -X DELETE "http://localhost/v1/runs/$plain" >/dev/null
wait_state "$plain" '^failed$' 15 >/dev/null
host_clean "plain run cancelled"

echo "== idle: the supervisor closes a session nobody uses"
id=$(post_session 'https://example.com/?stub=session&n=idle' '{"idle_s":5,"max_s":120}' | rid)
check "reaches the session state" "$(wait_state "$id" '^session$' 30)" '^session$'
start=$SECONDS
check "ends done on its own" "$(wait_state "$id" '^(done|failed)$' 25)" '^done$'
took=$((SECONDS - start))
check "after about idle_s (5 s), not at once and not at max_s" "$took" '^([4-9]|1[0-5])$'
final=$(api --max-time 10 "http://localhost/v1/runs/$id/events")
check "the close came from the supervisor" "$final" '"command_id":"idle-close".*"by":"supervisor"|"by":"supervisor".*"command_id":"idle-close"'
check "idle-close reached the guest and completed" "$(statuses "$final" idle-close)" '^accepted sent done $'
host_clean "idle close"

echo "== idle does not run while a human decides"
id=$(post_session 'https://example.com/?stub=session&n=wait-human' '{"idle_s":5,"max_s":120}' | rid)
wait_state "$id" '^session$' 30 >/dev/null
r=$(cmd "$id" '{"cmd":"download","id":"dl","snap":1,"ref":"e2"}')
sha=$(sha_of "$r")
sleep 9
check "after 9 s (idle_s is 5) the session is still there, waiting for the human" "$(state "$id")" '^session$'
check "approving late still works" "$(code_of "$(approve "$id" dl "$sha")")" '^202$'
check "the command arrives" "$(wait_event "$id" '"command_id":"dl".*"status":"done"' 10 && echo yes)" '^yes$'
check "then the idle clock runs and closes the session" "$(wait_state "$id" '^done$' 20)" '^done$'
host_clean "human decision"

echo "== a command the guest never answers ends the run (timeout 30 s)"
id=$(post_session 'https://example.com/?stub=session&hang_on=wait&n=hang' '{"idle_s":60,"max_s":120}' | rid)
wait_state "$id" '^session$' 30 >/dev/null
cmd "$id" '{"cmd":"wait","id":"stuck","ms":10}' >/dev/null
cmd "$id" '{"cmd":"snapshot","id":"behind"}' >/dev/null
start=$SECONDS
check "run fails" "$(wait_state "$id" '^failed$' 50)" '^failed$'
took=$((SECONDS - start))
check "reason timeout" "$(field "$(view "$id")" reason)" '^timeout$'
check "after about 30 s" "$took" '^(2[5-9]|3[0-9]|4[0-5])$'
final=$(api --max-time 10 "http://localhost/v1/runs/$id/events")
check "the unanswered command is marked timeout" "$(statuses "$final" stuck)" '^accepted sent timeout $'
check "the one behind it was never sent and is voided" "$(statuses "$final" behind)" '^accepted voided $'
host_clean "command timeout"

echo "== session slots: a second session waits, plain runs pass it"
s1=$(post_session 'https://example.com/?stub=session&n=slot1' '{"idle_s":60,"max_s":120}' | rid)
check "first session is up" "$(wait_state "$s1" '^session$' 30)" '^session$'
s2=$(post_session 'https://example.com/?stub=session&n=slot2' '{"idle_s":60,"max_s":120}' | rid)
p=$(post 'https://example.com/?stub=sleep&ms=1500&n=pass' | rid)
check "a plain run passes the waiting session and finishes" "$(wait_state "$p" '^done$' 30)" '^done$'
check "the second session still waits (a slot is free, a session slot is not)" "$(state "$s2")" '^queued$'
check "health: one session running, one waiting" "$(api http://localhost/v1/health)" '"queued":1,"sessions":\{"running":1,"limit":1\}'
close_run "$s1"
check "first session ends" "$(wait_state "$s1" '^done$' 20)" '^done$'
check "the second one now starts" "$(wait_state "$s2" '^session$' 30)" '^session$'
close_run "$s2"
check "second session ends" "$(wait_state "$s2" '^done$' 20)" '^done$'
host_clean "session slots"

echo "== cancelling a session with a command waiting for approval"
id=$(post_session 'https://example.com/?stub=session&n=cancel' '{"idle_s":60,"max_s":120}' | rid)
wait_state "$id" '^session$' 30 >/dev/null
cmd "$id" '{"cmd":"download","id":"dl","snap":1,"ref":"e2"}' >/dev/null
check "DELETE accepted" "$(api -o /dev/null -w '%{http_code}' -X DELETE "http://localhost/v1/runs/$id")" '^202$'
check "run fails" "$(wait_state "$id" '^failed$' 20)" '^failed$'
check "reason cancelled" "$(field "$(view "$id")" reason)" '^cancelled$'
final=$(api --max-time 10 "http://localhost/v1/runs/$id/events")
check "the waiting command is voided" "$(statuses "$final" dl)" '^accepted awaiting_approval voided $'
host_clean "cancelled session"

echo "== Firecracker killed with SIGKILL in a session"
id=$(post_session 'https://example.com/?stub=session&n=fckill' '{"idle_s":60,"max_s":120}' | rid)
wait_state "$id" '^session$' 30 >/dev/null
cmd "$id" '{"cmd":"download","id":"dl","snap":1,"ref":"e2"}' >/dev/null
pkill -9 -f "firecracker --api-sock .*--id $id"
check "run fails" "$(wait_state "$id" '^failed$' 20)" '^failed$'
check "reason fc_crashed" "$(field "$(view "$id")" reason)" '^fc_crashed$'
check "commands after the crash get 409" "$(code_of "$(cmd "$id" '{"cmd":"snapshot","id":"late"}')")" '^409$'
host_clean "firecracker killed in a session"

echo "== supervisor killed with SIGKILL in a session"
id=$(post_session 'https://example.com/?stub=session&n=supkill' '{"idle_s":60,"max_s":120}' | rid)
wait_state "$id" '^session$' 30 >/dev/null
cmd "$id" '{"cmd":"download","id":"dl","snap":1,"ref":"e2"}' >/dev/null
kill -9 "$(systemctl show -p MainPID --value zerostress-supervisor)"
for _ in $(seq 1 40); do api -m 2 http://localhost/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
check "service restarted by systemd" "$(systemctl is-active zerostress-supervisor)" '^active$'
check "the session is failed" "$(wait_state "$id" '^failed$' 20)" '^failed$'
check "reason supervisor_restart" "$(field "$(view "$id")" reason)" '^supervisor_restart$'
final=$(api --max-time 10 "http://localhost/v1/runs/$id/events")
check "the waiting command is voided in the log" "$(statuses "$final" dl)" '^accepted awaiting_approval voided $'
check "no approval can revive it" "$(code_of "$(approve "$id" dl "$sha")")" '^(404|409)$'
check "health shows no sessions" "$(api http://localhost/v1/health)" '"sessions":\{"running":0,"limit":1\}'
host_clean "supervisor killed in a session"

echo "== the service log keeps no URLs with queries and no typed-in values"
check "no URL with a query string in the journal" "$(journalctl -u zerostress-supervisor --no-pager 2>/dev/null | grep -c 'example.com/?')" '^0$'
check "the typed-in value never reached the journal" "$(journalctl -u zerostress-supervisor --no-pager 2>/dev/null | grep -c SECRETVALUE123)" '^0$'
check "control: the journal does contain command log lines" "$(journalctl -u zerostress-supervisor --no-pager 2>/dev/null | grep -c '"msg":"command"')" '^[1-9][0-9]*$'

[[ $fail == 0 ]] && echo "SUPERVISOR SESSIONS E2E OK" || echo "SUPERVISOR SESSIONS E2E FAILED"
exit $fail
