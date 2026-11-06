#!/usr/bin/env bash
# Containment, tried from the inside (CLAUDE.md, containment rules 1-5). Each wall is attacked from a real microVM, as the
# same unprivileged user the browser runs as, through the real supervisor and the real zsvm limits; then the host is
# measured to see whether the limits held and nothing was left behind.
#
# It lays the test collector (guest-image/test/stub-collector.mjs, probe modes) over a COPY of the installed image, swaps
# that copy in for the duration of the test and always puts the installed image back. While it runs, a real visitor of the
# service would get test answers: run it when nobody is using the site. Run as root on the host, after deploy/dev-sync.sh,
# with the supervisor service running.
#
# What this shows: the walls we built hold against a guest that tries to cross them. What it does NOT show: that no
# unknown flaw in the kernel or in Firecracker exists. That needs real exploits, which this project does not run.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e.sh"

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMG=/opt/zerostress/images/guest-rootfs.ext4
BACKUP=/var/tmp/zs-image-backup.ext4
MEM_MIB=${SUP_MEM_MIB:-1024}
WORK=$(mktemp -d)

[[ -e $BACKUP ]] && { echo "$BACKUP exists: an earlier run was interrupted. Put it back first (mv -f $BACKUP $IMG) after checking which image is the real one."; exit 1; }
[[ $(pgrep -c firecracker) == 0 ]] || { echo "a microVM is running; wait until the service is idle"; exit 1; }
[[ -x $SRC/guest-image/agent/zerostress-agent ]] || { echo "build the agent first (guest-image/build-agent.sh)"; exit 1; }

restore() { [[ -f $BACKUP ]] && mv -f "$BACKUP" "$IMG" && echo "installed image restored"; rm -rf "$WORK"; }
trap restore EXIT
cp --sparse=always "$IMG" "$BACKUP"
bash "$SRC/guest-image/apply-overlay.sh" "$IMG" "$SRC/guest-image/agent/zerostress-agent" "$SRC/guest-image/test/stub-collector.mjs" | tail -1
echo "test collector laid over the installed image (temporarily)"

HOST_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)

# sampler: reads the VM's systemd unit on the host while the run lives
sample() { # id outfile
  local u="zsvm-$1.service" f=$2
  : >"$f"
  while :; do
    local s
    s=$(systemctl show "$u" -p ActiveState -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p MemoryMax -p MemorySwapMax -p TasksMax -p CPUQuotaPerSecUSec 2>/dev/null | tr '\n' ' ')
    [[ $s == *ActiveState=active* ]] && echo "$(date +%s.%N) $s" >>"$f"
    [[ $(state "$1") =~ ^(done|failed)$ ]] && break
    sleep 0.4
  done
}

run_stub() { # query string -> sets RUN, SAMPLES
  RUN=$(post "https://example.com/?stub=$1" | rid)
  SAMPLES=$WORK/$RUN.samples
  sample "$RUN" "$SAMPLES" &
  SAMPLER=$!
  wait_state "$RUN" '^(done|failed)$' 150 >/dev/null
  wait "$SAMPLER" 2>/dev/null
}

prop() { grep -o "$2=[^ ]*" <<<"$1" | head -1 | cut -d= -f2; } # sample-line name

echo "== 1. the guest attacks its walls (probe)"
run_stub "probe&host_ip=$HOST_IP"
events=$(api "http://localhost/v1/runs/$RUN/events")
python3 - "$events" <<'PY'
import json, sys
walls = []
for line in sys.argv[1].splitlines():
    if line.startswith('data: '):
        try:
            d = json.loads(line[6:])
        except ValueError:
            continue
        if d.get('kind') == 'wall':
            walls.append(d)
for w in walls:
    print(('PASS  ' if w['ok'] else 'FAIL  ') + w['wall'] + ('' if w['ok'] else '  <- ' + str(w['detail'])))
print('WALLS', len(walls), 'FAILED', sum(1 for w in walls if not w['ok']))
PY
walls_line=$(python3 - "$events" <<'PY'
import json, sys
n = f = 0
for line in sys.argv[1].splitlines():
    if line.startswith('data: '):
        try:
            d = json.loads(line[6:])
        except ValueError:
            continue
        if d.get('kind') == 'wall':
            n += 1
            f += 0 if d['ok'] else 1
print(n, f)
PY
)
read -r nwalls nfailed <<<"$walls_line"
# 19 walls in guest-image/test/stub-collector.mjs (runProbes): if one is added or dropped, change this number on purpose
check "the probe ran every wall (a missing result is a failure, not a pass)" "$nwalls" '^19$'
check "no wall failed" "$nfailed" '^0$'
check "the run ended well" "$(state "$RUN")" '^done$'
host_clean "probe run"

echo "== 2. the limits on the host unit"
last=$(tail -1 "$SAMPLES")
memmax=$(prop "$last" MemoryMax); want=$(( (MEM_MIB + 640) * 1024 * 1024 ))
check "MemoryMax is the VM's memory plus 640 MiB" "$memmax" "^$want$"
check "swap is off for the VM" "$(prop "$last" MemorySwapMax)" '^0$'
check "CPU is capped at the number of vCPUs" "$(prop "$last" CPUQuotaPerSecUSec)" '^2s$'
check "tasks are capped" "$(prop "$last" TasksMax)" '^128$'

echo "== 3. memory: the guest holds more than its VM has"
run_stub "memhog&mb=$((MEM_MIB + 600))"
ev=$(api "http://localhost/v1/runs/$RUN/events")
peak=$(awk '{for(i=1;i<=NF;i++) if($i ~ /^MemoryPeak=[0-9]+$/){split($i,a,"=");if(a[2]>m)m=a[2]}} END{print m+0}' "$SAMPLES")
cur=$(awk '{for(i=1;i<=NF;i++) if($i ~ /^MemoryCurrent=[0-9]+$/){split($i,a,"=");if(a[2]>m)m=a[2]}} END{print m+0}' "$SAMPLES")
top=$(( peak > cur ? peak : cur ))
echo "     host unit peak: $((top / 1048576)) MiB of $((want / 1048576)) MiB allowed"
check "the hog really ran (the host unit held more than 800 MiB)" "$([[ $top -gt $((800*1024*1024)) ]] && echo yes || echo no)" '^yes$'
check "the host unit never passed its ceiling" "$([[ $top -le $want ]] && echo yes || echo no)" '^yes$'
check "the hog did not finish: the guest stopped it inside the VM" "$(grep -c '"kind":"memhog_done"' <<<"$ev")" '^0$'
check "the service is still healthy" "$(api -m 5 http://localhost/v1/health | grep -c '"ok":true\|"status":"ok"\|ok')" '^[1-9]'
host_clean "memory hog"

echo "== 4. CPU: the guest burns every thread it can"
run_stub "cpuburn&ms=8000"
read -r first_t first_c <<<"$(awk 'NR>1 && /CPUUsageNSec=[0-9]+/ {for(i=1;i<=NF;i++) if($i ~ /^CPUUsageNSec=/){split($i,a,"=");print $1, a[2]; exit}}' "$SAMPLES")"
read -r last_t last_c <<<"$(awk '/CPUUsageNSec=[0-9]+/ {for(i=1;i<=NF;i++) if($i ~ /^CPUUsageNSec=/){split($i,a,"=");t=$1;c=a[2]}} END{print t, c}' "$SAMPLES")"
ratio=$(awk -v a="$first_c" -v b="$last_c" -v t0="$first_t" -v t1="$last_t" 'BEGIN{ if (t1>t0) printf "%.2f", (b-a)/1e9/(t1-t0); else print 0 }')
echo "     host unit used $ratio CPUs on average while burning"
check "the burn really used the CPU (more than 1.2 CPUs)" "$(awk -v r="$ratio" 'BEGIN{print (r>1.2)?"yes":"no"}')" '^yes$'
check "the unit never used more than its 2 CPUs (with a small margin)" "$(awk -v r="$ratio" 'BEGIN{print (r<=2.2)?"yes":"no"}')" '^yes$'
host_clean "CPU burn"

echo "== 5. disk and scratch space: the guest writes a lot"
# /tmp in the guest is memory-backed and bounded: the guest must be stopped by its own 'no space left', not by the host
run_stub "diskfill&mb=900&to=tmp"
ev=$(api "http://localhost/v1/runs/$RUN/events")
check "the scratch space is bounded: the write was stopped by the guest (no space left)" "$(grep -c 'ENOSPC' <<<"$ev")" '^[1-9]'
check "the scratch write did not finish" "$(grep -c '"kind":"diskfill_done"' <<<"$ev")" '^0$'
host_clean "scratch fill"
# the real disk: written data lands in the VM's own copy of the image, which cannot grow past its size
run_stub "diskfill&mb=512&to=home"
ev=$(api "http://localhost/v1/runs/$RUN/events")
check "512 MiB written to the guest's disk" "$(grep -c '"kind":"diskfill_done"' <<<"$ev")" '^1$'
check "the run ended" "$(state "$RUN")" '^(done|failed)$'
host_clean "disk fill"
echo "     (a guest that fills the whole disk is bounded by the image size, 5 GiB, by construction: not run here, it takes minutes)"

echo "== 6. the run is cancelled in the middle: nothing is left"
RUN=$(post 'https://example.com/?stub=sleep&ms=60000' | rid)
wait_state "$RUN" '^running$' 30 >/dev/null
api -X DELETE "http://localhost/v1/runs/$RUN" >/dev/null
wait_state "$RUN" '^(done|failed)$' 30 >/dev/null
host_clean "cancelled run"

echo
((fail)) && { echo "CONTAINMENT: SOMETHING FAILED"; exit 1; }
echo "CONTAINMENT: all checks passed"
