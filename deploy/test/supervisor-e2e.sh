#!/usr/bin/env bash
# End-to-end test of the installed supervisor service with real microVMs. Run as root on the host.
# Needs: deploy/006-supervisor.sh done, guest image installed with the stub collector (guest-image/build.sh default).
set -uo pipefail
SOCK=/run/zerostress/supervisor.sock
RUNS=/var/lib/zerostress/runs
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
  local p q d
  p=$(pgrep -c firecracker); q=$(ip -br link | grep -c zstap); d=$(ls -A "$RUNS" | wc -l)
  [[ $p == 0 && $q == 0 && $d == 0 ]] && ok "host clean after: $1" || bad "host clean after: $1" "firecracker=$p zstap=$q rundirs=$d"
}

echo "== service"
check "service active" "$(systemctl is-active zerostress-supervisor)" '^active$'
h=$(api http://localhost/v1/health)
check "health ok with image checksum" "$h" '"ok":true.*"image_sha256":"[0-9a-f]{64}"'
check "socket is 0660 group zerostress-ipc" "$(stat -c '%a %G' $SOCK)" '^660 zerostress-ipc$'

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
check "SSE ends with the done state" "$ev" '"state":"done"[^"]*"?[^e]*$'
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
  r=$(api http://localhost/v1/health | grep -o '"running":[0-9]*' | cut -d: -f2)
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
