#!/usr/bin/env bash
# End-to-end test of the installed supervisor service with real microVMs. Run as root on the host.
# Needs: deploy/steps/50-supervisor.sh done, guest image installed with the stub collector (COLLECTOR_ENTRY=deploy/test/stub-collector.mjs guest/image/build.sh).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e.sh"

echo "== controls: the detectors of this test must be able to fail"
ip link add zstap9 type dummy
out=$( (host_clean "control") 2>&1 )
ip link del zstap9
[[ $out =~ FAIL ]] && ok "control: host_clean notices a leftover interface" || bad "control: host_clean is blind" "$out"
check "control: state of an unknown run is empty" "$(state 00000000-0000-4000-8000-000000000000)" '^$'
check "control: wait_state reports a timeout instead of success" "$(wait_state 00000000-0000-4000-8000-000000000000 '^done$' 1)" '^timeout'

echo "== service"
check "service active" "$(systemctl is-active zerostress-supervisor)" '^active$'
h=$(api http://localhost/v1/health)
check "health ok with image checksum" "$h" '"ok":true.*"image_sha256":"[0-9a-f]{64}"'
check "socket is 0660 group zerostress-ipc" "$(stat -c '%a %G' $SOCK)" '^660 zerostress-ipc$'

echo "== who may talk to the socket"
code() { sudo -u "$1" curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --unix-socket "$SOCK" http://localhost/v1/health 2>/dev/null; }
check "web user (group zerostress-ipc) gets 200" "$(code zerostress-web)" '^200$'
check "supervisor user itself gets 200" "$(code zerostress-sup)" '^200$'
check "linuxuser (not in the group) is refused" "$(code linuxuser)" '^000$'
check "nobody is refused" "$(code nobody)" '^000$'

echo "== request validation"
check "file: URL rejected" "$(api -o /dev/null -w '%{http_code}' -X POST -d '{"kind":"url","url":"file:///etc/passwd"}' http://localhost/v1/runs)" '^400$'
check "garbage rejected" "$(api -o /dev/null -w '%{http_code}' -X POST -d 'zzz' http://localhost/v1/runs)" '^400$'
check "unknown field rejected" "$(api -o /dev/null -w '%{http_code}' -X POST -d '{"kind":"url","url":"https://a.b","x":1}' http://localhost/v1/runs)" '^400$'

echo "== happy path: guest fetches a public page"
id=$(post 'https://example.com/' | rid)
check "accepted" "$id" '^[0-9a-f-]{36}$'
check "reaches done" "$(wait_state "$id" '^(done|failed)$' 60)" '^done$'
ev=$(api --max-time 10 "http://localhost/v1/runs/$id/events")
check "SSE has evidence from the guest (HTTP 200)" "$ev" 'event: evidence.*"status":200'
check "SSE has the agent status" "$ev" 'event: status.*"status":"ok"'
check "SSE ends with the done state" "$(grep '^data:' <<<"$ev" | tail -1)" '"state":"done"'
v=$(view "$id")
check "view has no url" "$(grep -c '"url"' <<<"$v")" '^0$'
host_clean "happy path"

echo "== cancel a running job"
id=$(post 'https://example.com/?stub=sleep&ms=30000' | rid)
check "reaches running" "$(wait_state "$id" '^running$' 30)" '^running$'
check "DELETE accepted" "$(api -o /dev/null -w '%{http_code}' -X DELETE "http://localhost/v1/runs/$id")" '^202$'
check "ends failed" "$(wait_state "$id" '^failed$' 15)" '^failed$'
check "reason cancelled" "$(field "$(view "$id")" reason)" '^cancelled$'
host_clean "cancel"

echo "== Firecracker killed with SIGKILL mid-run"
id=$(post 'https://example.com/?stub=sleep&ms=30000' | rid)
check "reaches running" "$(wait_state "$id" '^running$' 30)" '^running$'
pkill -9 -f "firecracker --api-sock .*--id $id"
check "ends failed" "$(wait_state "$id" '^failed$' 15)" '^failed$'
check "reason fc_crashed" "$(field "$(view "$id")" reason)" '^fc_crashed$'
host_clean "firecracker killed"

echo "== supervisor killed with SIGKILL mid-run (crash recovery)"
id=$(post 'https://example.com/?stub=sleep&ms=30000' | rid)
check "reaches running" "$(wait_state "$id" '^running$' 30)" '^running$'
mainpid=$(systemctl show -p MainPID --value zerostress-supervisor)
kill -9 "$mainpid"
for _ in $(seq 1 40); do [[ -S $SOCK ]] && api -m 2 http://localhost/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
check "service restarted by systemd" "$(systemctl is-active zerostress-supervisor)" '^active$'
check "interrupted run is failed" "$(wait_state "$id" '^failed$' 20)" '^failed$'
check "reason supervisor_restart" "$(field "$(view "$id")" reason)" '^supervisor_restart$'
host_clean "supervisor crash"

echo "== queued runs survive a supervisor crash, running ones do not"
r1=$(post 'https://example.com/?stub=sleep&ms=30000&n=r1' | rid); r2=$(post 'https://example.com/?stub=sleep&ms=30000&n=r2' | rid)
q1=$(post 'https://example.com/?stub=sleep&ms=3000&n=q1' | rid); q2=$(post 'https://example.com/?stub=sleep&ms=3000&n=q2' | rid)
check "first two are running" "$(wait_state "$r1" '^running$' 30) $(wait_state "$r2" '^running$' 30)" '^running running$'
check "the other two wait in the queue" "$(state "$q1") $(state "$q2")" '^queued queued$'
kill -9 "$(systemctl show -p MainPID --value zerostress-supervisor)"
for _ in $(seq 1 40); do api -m 2 http://localhost/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
check "running ones failed with supervisor_restart" "$(wait_state "$r1" '^failed$' 20) $(field "$(view "$r1")" reason) $(wait_state "$r2" '^failed$' 5) $(field "$(view "$r2")" reason)" '^failed supervisor_restart failed supervisor_restart$'
check "queued ones ran to the end after the restart" "$(wait_state "$q1" '^done$' 60) $(wait_state "$q2" '^done$' 60)" '^done done$'
host_clean "queue across a crash"

echo "== graceful restart mid-run"
id=$(post 'https://example.com/?stub=sleep&ms=30000' | rid)
check "reaches running" "$(wait_state "$id" '^running$' 30)" '^running$'
systemctl restart zerostress-supervisor
for _ in $(seq 1 40); do api -m 2 http://localhost/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
check "reason supervisor_restart" "$(field "$(view "$id")" reason)" '^supervisor_restart$'
host_clean "graceful restart"

echo "== queue: 4 jobs, 2 slots"
ids=()
for i in 1 2 3 4; do ids+=("$(post "https://example.com/?stub=sleep&ms=4000&n=$i" | rid)"); done
sleep 1.5
peak=0
for _ in $(seq 1 40); do
  r=$(api http://localhost/v1/health | grep -o '"running":[0-9]*' | head -1 | cut -d: -f2) # the first one: "sessions" has its own "running"
  ((r > peak)) && peak=$r
  done_n=0; for i in "${ids[@]}"; do [[ $(state "$i") =~ ^(done|failed)$ ]] && ((done_n++)); done
  ((done_n == 4)) && break
  sleep 0.5
done
check "never more than 2 microVMs at once" "$peak" '^[12]$'
all=""; for i in "${ids[@]}"; do all+="$(state "$i") "; done
check "all four finished done" "$all" '^done done done done $'
host_clean "queue"

echo "== five quick jobs in a row"
for i in 1 2 3 4 5; do
  id=$(post "https://example.com/?n=$i" | rid)
  s=$(wait_state "$id" '^(done|failed)$' 60)
  [[ $s == done ]] || bad "quick job $i" "$s"
done
host_clean "five jobs"

echo "== service log has no full URLs"
n=$(journalctl -u zerostress-supervisor --no-pager 2>/dev/null | grep -c 'example.com/?')
check "no URL with a query string in the journal" "$n" '^0$'

[[ $fail == 0 ]] && echo "SUPERVISOR E2E OK" || echo "SUPERVISOR E2E FAILED"
exit $fail
