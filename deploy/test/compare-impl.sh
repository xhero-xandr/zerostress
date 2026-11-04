#!/usr/bin/env bash
# Measures the installed supervisor (whichever implementation runs as zerostress-supervisor) for the TypeScript/Go
# comparison: what it takes on disk, how fast it starts, how much memory it holds, how much CPU a series of jobs costs.
# Run as root on the host, after deploy/006-supervisor.sh (IMPL=ts or IMPL=go). Prints key=value lines.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e.sh"
JOBS=${JOBS:-12}

pid() { systemctl show -p MainPID --value zerostress-supervisor; }
rss_kb() { awk '/^VmRSS/ {print $2}' "/proc/$(pid)/status"; }
hwm_kb() { awk '/^VmHWM/ {print $2}' "/proc/$(pid)/status"; }
threads() { awk '/^Threads/ {print $2}' "/proc/$(pid)/status"; }
cpu_ticks() { awk '{print $14 + $15}' "/proc/$(pid)/stat"; }
tick=$(getconf CLK_TCK)

exe=$(readlink "/proc/$(pid)/exe")
impl=go; [[ $exe == */node ]] && impl=ts
echo "impl=$impl"
echo "executable=$exe"
if [[ $impl == ts ]]; then
  echo "installed_bytes=$(du -sb /opt/zerostress/supervisor | cut -f1)"
  echo "runtime_bytes=$(du -sbL /opt/node | cut -f1)  # Node is needed on the host for the supervisor"
else
  echo "installed_bytes=$(du -sb /opt/zerostress/supervisor-go | cut -f1)"
  echo "runtime_bytes=0  # static binary, no runtime on the host"
fi

# start-up: restart, wait for the first answer
t0=$(date +%s.%N)
systemctl restart zerostress-supervisor
for _ in $(seq 1 200); do api -m 1 http://localhost/v1/health >/dev/null 2>&1 && break; sleep 0.05; done
t1=$(date +%s.%N)
echo "startup_seconds=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')"
sleep 1
echo "idle_rss_kb=$(rss_kb)"
echo "idle_threads=$(threads)"

# a series of short jobs through the whole path (disk copy, network, microVM, agent, stub, teardown)
c0=$(cpu_ticks)
w0=$(date +%s.%N)
ids=()
for i in $(seq 1 "$JOBS"); do ids+=("$(post "https://example.com/?stub=sleep&ms=100&n=$i" | rid)"); done
bad=0
for i in "${ids[@]}"; do [[ $(wait_state "$i" '^(done|failed)$' 180) == done ]] || bad=$((bad + 1)); done
w1=$(date +%s.%N)
c1=$(cpu_ticks)
echo "jobs=$JOBS failed=$bad"
echo "wall_seconds=$(awk -v a="$w1" -v b="$w0" 'BEGIN{printf "%.1f", a-b}')"
echo "supervisor_cpu_seconds=$(awk -v a="$c1" -v b="$c0" -v t="$tick" 'BEGIN{printf "%.2f", (a-b)/t}')"
echo "rss_after_kb=$(rss_kb)"
echo "peak_rss_kb=$(hwm_kb)"
echo "threads_after=$(threads)"
host_clean "comparison run" | sed 's/^/check: /'
