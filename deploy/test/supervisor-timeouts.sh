#!/usr/bin/env bash
# Time limits on real microVMs: the agent's 60 s collector limit and the supervisor's hard cap.
# Temporarily lowers SUP_HARD_TIMEOUT_S through a systemd drop-in and always restores it. Run as root.
set -uo pipefail
SOCK=/run/zerostress/supervisor.sock
DROPIN=/etc/systemd/system/zerostress-supervisor.service.d/timeouts-test.conf
fail=0

api() { curl -sS --max-time 30 --unix-socket "$SOCK" "$@"; }
post() { api -X POST -H 'content-type: application/json' -d "{\"kind\":\"url\",\"url\":\"$1\"}" http://localhost/v1/runs; }
rid() { grep -o '"run_id":"[^"]*"' | head -1 | cut -d'"' -f4; }
field() { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -1 | cut -d'"' -f4; }
view() { api "http://localhost/v1/runs/$1"; }
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1${2:+: $2}"; fail=1; }
check() { [[ $2 =~ $3 ]] && ok "$1" || bad "$1" "got '$2', wanted /$3/"; }
wait_terminal() { local end=$((SECONDS + $2)) s; while ((SECONDS < end)); do s=$(field "$(view "$1")" state); [[ $s =~ ^(done|failed)$ ]] && return 0; sleep 0.3; done; return 1; }
wait_health() { for _ in $(seq 1 40); do api -m 2 http://localhost/v1/health >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
clean_host() { sleep 1; [[ $(pgrep -c firecracker) == 0 && $(ip -br link | grep -c zstap) == 0 && $(ls -A /var/lib/zerostress/runs | wc -l) == 0 ]]; }

restore() {
  rm -f "$DROPIN"; rmdir "$(dirname "$DROPIN")" 2>/dev/null
  systemctl daemon-reload; systemctl restart zerostress-supervisor
}
trap restore EXIT

echo "== agent limit: a collector that runs too long is stopped by the agent (60 s inside the guest)"
wait_health || bad "service reachable"
id=$(post 'https://example.com/?stub=sleep&ms=200000' | rid)
t0=$SECONDS
wait_terminal "$id" 100 || bad "run did not finish within 100 s"
dur=$((SECONDS - t0)); v=$(view "$id")
check "failed with reason timeout" "$(field "$v" state) $(field "$v" reason)" '^failed timeout$'
check "reported by the agent" "$(field "$v" agent_status)" '^timeout$'
echo "INFO  took ${dur}s"
((dur >= 55 && dur <= 85)) && ok "duration matches the 60 s agent limit" || bad "duration ${dur}s is not near 60 s"
clean_host && ok "host clean" || bad "host not clean"

echo "== supervisor hard cap (lowered to 20 s for this test)"
mkdir -p "$(dirname "$DROPIN")"
printf '[Service]\nEnvironment=SUP_HARD_TIMEOUT_S=20\n' > "$DROPIN"
systemctl daemon-reload; systemctl restart zerostress-supervisor
wait_health && ok "service back with the drop-in" || bad "service back"
id=$(post 'https://example.com/?stub=sleep&ms=200000' | rid)
t0=$SECONDS
wait_terminal "$id" 60 || bad "run did not finish within 60 s"
dur=$((SECONDS - t0)); v=$(view "$id")
check "failed with reason timeout" "$(field "$v" state) $(field "$v" reason)" '^failed timeout$'
check "no agent status: the supervisor cut it, not the agent" "$(grep -c '"agent_status":null' <<<"$v")" '^1$'
echo "INFO  took ${dur}s"
((dur >= 18 && dur <= 30)) && ok "duration matches the 20 s cap" || bad "duration ${dur}s is not near 20 s"
clean_host && ok "host clean" || bad "host not clean"

[[ $fail == 0 ]] && echo "TIMEOUTS OK" || echo "TIMEOUTS FAILED"
exit $fail
