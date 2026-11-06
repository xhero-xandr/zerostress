#!/usr/bin/env bash
# Runs INSIDE a hardened transient unit as zerostress-sup (see unit-compat.sh). Walks the supervisor's path:
# run dir -> disk copy -> sudo zsnet up -> Firecracker via REST (incl. vsock) -> job via agent -> teardown.
set -u
D=/var/lib/zerostress/runs/compat
IMG=/opt/zerostress/images/guest-rootfs.ext4
KERNEL=/opt/zerostress/images/vmlinux-6.18.56
CLIENT=/opt/zerostress-src/deploy/test/vsock-client.mjs
NODE=/opt/node/bin/node
RC=0
FCPID=

pass() { echo "PASS  $1"; }
bad()  { echo "FAIL  $1${2:+: $2}"; RC=1; }
put()  { curl -sS --max-time 5 --unix-socket "$D/fc.sock" -o /dev/null -w '%{http_code}' -X PUT \
           -H 'Content-Type: application/json' -d "$2" "http://localhost$1" 2>&1; }
rest() { local code; code=$(put "$1" "$2"); [[ $code == 204 ]] && pass "REST PUT $1" || { bad "REST PUT $1" "HTTP $code"; return 1; }; }

teardown() {
  [[ -n $FCPID ]] && { kill -TERM "$FCPID" 2>/dev/null; sleep 1; kill -KILL "$FCPID" 2>/dev/null; }
  sudo -n /opt/zerostress/bin/zsnet down 0 2>&1 | sed 's/^/  zsnet down: /'
  rm -rf "$D"
}
trap teardown EXIT

mkdir -p "$D" && chmod 700 "$D" && pass "create run dir" || { bad "create run dir"; exit 1; }
cp --sparse=always "$IMG" "$D/rootfs.ext4" && pass "disk copy" || { bad "disk copy"; exit 1; }

out=$(sudo -n /opt/zerostress/bin/zsnet up 0 2>&1) && pass "sudo zsnet up 0" || { bad "sudo zsnet up 0" "$(echo "$out" | head -2 | tr '\n' ' ')"; exit 1; }

/opt/zerostress/bin/firecracker --api-sock "$D/fc.sock" --id compat >"$D/fc.out" 2>&1 &
FCPID=$!
for _ in $(seq 1 30); do [[ -S $D/fc.sock ]] && break; sleep 0.1; done
[[ -S $D/fc.sock ]] && pass "firecracker API socket" || { bad "firecracker API socket" "$(head -c 300 "$D/fc.out")"; exit 1; }

rest /machine-config '{"vcpu_count":2,"mem_size_mib":1024}' || exit 1
rest /boot-source "{\"kernel_image_path\":\"$KERNEL\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off:1.1.1.1\"}" || exit 1
rest /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"$D/rootfs.ext4\",\"is_root_device\":true,\"is_read_only\":false}" || exit 1
rest /network-interfaces/net1 '{"iface_id":"net1","guest_mac":"06:00:AC:10:00:02","host_dev_name":"zstap0"}' || exit 1
rest /vsock "{\"guest_cid\":3,\"uds_path\":\"$D/v.sock\"}" || exit 1
rest /actions '{"action_type":"InstanceStart"}' || exit 1

ready=0
for _ in $(seq 1 80); do
  "$NODE" "$CLIENT" "$D/v.sock" 5000 '{}' --probe 2>/dev/null && { ready=1; break; }
  sleep 0.25
done
[[ $ready == 1 ]] && pass "agent reachable over vsock" || { bad "agent reachable over vsock" "$(tail -c 300 "$D/fc.out")"; exit 1; }

res=$("$NODE" "$CLIENT" "$D/v.sock" 5000 '{"mode":"fetch","url":"https://example.com"}' 2>/dev/null)
grep -q '"status":200' <<<"$res" && grep -q '"status":"ok"' <<<"$res" && pass "job over vsock, guest reaches the internet" || bad "job over vsock" "$(echo "$res" | tail -c 200)"

kill -TERM "$FCPID" 2>/dev/null; sleep 1; kill -KILL "$FCPID" 2>/dev/null
kill -0 "$FCPID" 2>/dev/null && bad "firecracker stopped" || pass "firecracker stopped"
FCPID=
exit $RC
