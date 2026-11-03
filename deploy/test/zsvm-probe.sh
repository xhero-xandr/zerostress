#!/usr/bin/env bash
# Feasibility of "one systemd unit per microVM": cgroup limits, guaranteed network teardown, signal behaviour.
# Real Firecracker, real guest, SELinux Enforcing. Run as root on the host.
set -uo pipefail
D=/var/lib/zerostress/runs/zsvm-probe
IMG=/opt/zerostress/images/guest-rootfs.ext4
KERNEL=/opt/zerostress/images/vmlinux-6.18.56
CLIENT=/opt/zerostress-src/guest-image/test/vsock-client.mjs
NODE=/opt/node/bin/node
UNIT=zsvm-probe
SUP=zerostress-sup
CG=/sys/fs/cgroup/system.slice/$UNIT.service
fail=0

ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1${2:+: $2}"; fail=1; }
check() { [[ $2 =~ $3 ]] && ok "$1" || bad "$1" "got '$2', wanted /$3/"; }
asup() { sudo -u $SUP "$@"; }
put() { asup curl -sS --max-time 5 --unix-socket "$D/fc.sock" -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -d "$2" "http://localhost$1"; }
mainpid() { systemctl show -p MainPID --value $UNIT; }
unit_gone() { ! systemctl is-active -q $UNIT; }

cleanup() {
  systemctl stop $UNIT 2>/dev/null; systemctl reset-failed $UNIT 2>/dev/null
  /opt/zerostress/bin/zsnet down 0 2>/dev/null
  rm -rf "$D"
}
trap cleanup EXIT
cleanup
install -d -m 0700 -o $SUP -g $SUP "$D"

# the limits a supervisor would apply to every VM (guest RAM 1024 MiB + Firecracker overhead)
start_vm() {
  asup rm -f "$D/rootfs.ext4" "$D/fc.sock" "$D/v.sock"
  asup cp --sparse=always "$IMG" "$D/rootfs.ext4"
  /opt/zerostress/bin/zsnet up 0 || return 1
  systemctl reset-failed $UNIT 2>/dev/null
  systemd-run --quiet --unit=$UNIT -p User=$SUP -p SupplementaryGroups=kvm -p WorkingDirectory="$D" \
    -p MemoryMax=1700M -p MemorySwapMax=0 -p CPUQuota=200% -p TasksMax=256 -p "IOWriteBandwidthMax=/dev/vda 200M" \
    -p TimeoutStopSec=10 -p "ExecStopPost=+/opt/zerostress/bin/zsnet down 0" \
    /opt/zerostress/bin/firecracker --api-sock "$D/fc.sock" --id probe || return 1
  for _ in $(seq 1 50); do [[ -S $D/fc.sock ]] && break; sleep 0.1; done
  [[ -S $D/fc.sock ]] || return 1
}
configure() {
  local c
  for spec in \
    '/machine-config|{"vcpu_count":2,"mem_size_mib":1024}' \
    "/boot-source|{\"kernel_image_path\":\"$KERNEL\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off:1.1.1.1\"}" \
    "/drives/rootfs|{\"drive_id\":\"rootfs\",\"path_on_host\":\"$D/rootfs.ext4\",\"is_root_device\":true,\"is_read_only\":false}" \
    '/network-interfaces/net1|{"iface_id":"net1","guest_mac":"06:00:AC:10:00:02","host_dev_name":"zstap0"}' \
    "/vsock|{\"guest_cid\":3,\"uds_path\":\"$D/v.sock\"}" \
    '/actions|{"action_type":"InstanceStart"}'; do
    c=$(put "${spec%%|*}" "${spec#*|}"); [[ $c == 204 ]] || { echo "REST ${spec%%|*} -> $c"; return 1; }
  done
}
wait_ready() { for _ in $(seq 1 80); do asup $NODE "$CLIENT" "$D/v.sock" 5000 '{}' --probe 2>/dev/null && return 0; sleep 0.25; done; return 1; }
wait_unit_gone() { # seconds -> prints elapsed seconds
  local t0 end; t0=$(date +%s.%N); end=$((SECONDS + $1))
  while ! unit_gone && ((SECONDS < end)); do sleep 0.05; done
  awk -v s="$t0" -v e="$(date +%s.%N)" 'BEGIN{printf "%.2f", e-s}'
}
zstap_present() { ip -br link | grep -q '^zstap0'; }

echo "== 1. Firecracker as a systemd unit, booted and running a job"
start_vm && ok "unit started as zerostress-sup" || { bad "unit started"; exit 1; }
configure && ok "REST configuration (204 x6)" || { bad "REST configuration"; exit 1; }
wait_ready && ok "agent reachable over vsock" || { bad "agent reachable"; exit 1; }
res=$(asup $NODE "$CLIENT" "$D/v.sock" 5000 '{"kind":"url","url":"https://example.com/"}' 2>/dev/null)
check "job runs, guest reaches the internet" "$res" '"status":200.*"status":"ok"'

echo "== 2. limits are really in the cgroup"
check "memory.max"  "$(cat $CG/memory.max 2>&1)" '^1782579200$'
check "memory.swap.max" "$(cat $CG/memory.swap.max 2>&1)" '^0$'
check "cpu.max (200%)" "$(cat $CG/cpu.max 2>&1)" '^200000 100000$'
check "pids.max" "$(cat $CG/pids.max 2>&1)" '^256$'
check "io.max has the write cap (systemd reads 200M as 200000000)" "$(cat $CG/io.max 2>&1)" 'wbps=200000000'
peak=$(( $(cat $CG/memory.peak 2>/dev/null || echo 0) / 1024 / 1024 ))
echo "INFO  memory.peak of a booted 1024 MiB guest after one job: ${peak} MiB (limit 1700)"
check "memory peak below the limit" "$peak" '^[0-9]+$'
((peak < 1700)) && ok "no OOM headroom problem" || bad "memory peak at the limit"

echo "== 3. SIGTERM alone (no SIGKILL), booted guest"
pid=$(mainpid); kill -TERM "$pid"
el=$(wait_unit_gone 10)
unit_gone && ok "Firecracker exited on SIGTERM in ${el}s" || bad "Firecracker did not exit on SIGTERM within 10s"
sleep 0.5
zstap_present && bad "zstap0 still present after unit end (ExecStopPost did not run)" || ok "ExecStopPost removed zstap0"

echo "== 4. SIGTERM right after InstanceStart (guest still booting)"
start_vm && configure || { bad "second boot"; exit 1; }
pid=$(mainpid); kill -TERM "$pid"
el=$(wait_unit_gone 10)
unit_gone && ok "Firecracker exited on SIGTERM mid-boot in ${el}s" || bad "no exit on SIGTERM mid-boot"
sleep 0.5; zstap_present && bad "zstap0 left after mid-boot SIGTERM" || ok "zstap0 removed"

echo "== 5. crash: SIGKILL of the main process only"
start_vm && configure && wait_ready || { bad "third boot"; exit 1; }
pid=$(mainpid); kill -9 "$pid"
el=$(wait_unit_gone 10)
unit_gone && ok "unit ended after SIGKILL (${el}s)" || bad "unit still active"
check "unit state is failed" "$(systemctl is-failed $UNIT)" '^failed$'
sleep 0.5; zstap_present && bad "zstap0 left after a crash" || ok "ExecStopPost removed zstap0 after a crash"
check "no firecracker process left" "$(pgrep -c firecracker)" '^0$'

[[ $fail == 0 ]] && echo "ZSVM PROBE OK" || echo "ZSVM PROBE FAILED"
exit $fail
