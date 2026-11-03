#!/usr/bin/env bash
# Smoke test of the guest image: overlay -> boot with vsock -> agent -> stub collector. Run as root on the host.
# Usage: smoke.sh BASE_IMAGE AGENT_BIN   (defaults: the installed base image, /tmp/zerostress-agent)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=${1:-/opt/zerostress/images/guest-base.ext4}
AGENT=${2:-/tmp/zerostress-agent}
D=/var/lib/zerostress/runs/smoke
NODE=/opt/node/bin/node
SUP=zerostress-sup
UDS=$D/v.sock
UNIT=fc-smoke
fail=0

q() { sudo -u $SUP sudo -n /opt/zerostress/bin/zsnet "$@"; }
cleanup() {
  systemctl stop $UNIT 2>/dev/null
  q down 0 2>/dev/null
  rm -rf "$D"
}
trap cleanup EXIT
cleanup

install -d -m 0700 -o $SUP -g $SUP "$D"
echo "== copy + overlay"
t=$(date +%s.%N); cp --sparse=always "$BASE" "$D/rootfs.ext4"
printf 'copy %.2fs\n' "$(awk -v a="$(date +%s.%N)" -v b="$t" "BEGIN{print a-b}")"
bash "$HERE/../apply-overlay.sh" "$D/rootfs.ext4" "$AGENT" "$HERE/stub-collector.mjs" | tail -2
[[ ${PIPESTATUS[0]} == 0 ]] || { echo "overlay failed"; exit 1; }
chown $SUP:$SUP "$D/rootfs.ext4"; chmod 0600 "$D/rootfs.ext4"

cat >"$D/vm.json" <<J
{"boot-source":{"kernel_image_path":"/opt/zerostress/images/vmlinux-6.18.56",
  "boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off:1.1.1.1"},
 "drives":[{"drive_id":"rootfs","path_on_host":"$D/rootfs.ext4","is_root_device":true,"is_read_only":false}],
 "network-interfaces":[{"iface_id":"net1","guest_mac":"06:00:AC:10:00:02","host_dev_name":"zstap0"}],
 "vsock":{"guest_cid":3,"uds_path":"$UDS"},
 "machine-config":{"vcpu_count":2,"mem_size_mib":1024}}
J
chown $SUP:$SUP "$D/vm.json"

echo "== boot"
q up 0 || exit 1
t0=$(date +%s.%N)
systemd-run -q --collect --unit=$UNIT -p User=$SUP -p RuntimeMaxSec=240 \
  -p StandardOutput=file:$D/serial.log -p StandardError=file:$D/err.log \
  /opt/zerostress/bin/firecracker --no-api --config-file "$D/vm.json"

ready=0
for i in $(seq 1 60); do
  if sudo -u $SUP $NODE "$HERE/vsock-client.mjs" "$UDS" 5000 '{}' --probe 2>/dev/null; then ready=1; break; fi
  sleep 0.25
done
printf 'agent ready after %.1fs (ready=%s)\n' "$(awk -v a="$(date +%s.%N)" -v b="$t0" "BEGIN{print a-b}")" "$ready"
[[ $ready == 1 ]] || { tail -30 "$D/serial.log"; exit 1; }

run() { sudo -u $SUP $NODE "$HERE/vsock-client.mjs" "$UDS" 5000 "$1" 2>"$D/c.err"; }
check() { # name, output, regex
  if grep -qE "$3" <<<"$2"; then echo "PASS  $1"; else echo "FAIL  $1"; echo "$2" | cut -c1-200 | head -5; fail=1; fi
}

echo "== scenarios"
out=$(run '{"mode":"hello"}');  check "hello + status ok" "$out" '"status":"ok"'
out=$(run '{"mode":"whoami"}'); check "collector runs as pw" "$out" '"out":"pw"'
out=$(run '{"mode":"fetch","url":"https://example.com"}'); check "public internet via guest" "$out" '"status":200'
out=$(run '{"mode":"fetch","url":"http://169.254.169.254/","timeout_ms":3000}'); check "metadata blocked" "$out" '"kind":"error"'
out=$(run '{"mode":"fetch","url":"http://172.16.0.1:22/","timeout_ms":3000}');   check "host gateway blocked" "$out" '"kind":"error"'
out=$(run '{"mode":"flood"}');  check "oversize capped" "$out" '"status":"oversize"'
size=$(run '{"mode":"flood"}' | wc -c); [[ $size -le 1048900 ]] && echo "PASS  forwarded $size bytes (cap 1048576 + status)" || { echo "FAIL  forwarded $size"; fail=1; }
out=$(run 'garbage');           check "bad job rejected" "$out" '"status":"bad_job"'

# busy: two simultaneous jobs
( run '{"mode":"sleep","ms":3000}' >/dev/null ) &
sleep 0.7
out=$(run '{"mode":"hello"}');  check "second job gets busy" "$out" '"status":"busy"'
wait

echo "== guest listening ports are not observable without a shell; checking secrets in image"
M=$(mktemp -d); mount -o ro,loop,noload "$D/rootfs.ext4" $M
ls $M/etc/ssh/ssh_host_* 2>/dev/null && { echo "FAIL  host keys present"; fail=1; } || echo "PASS  no ssh host keys"
[[ -e $M/root/.ssh/authorized_keys ]] && { echo "FAIL  authorized_keys present"; fail=1; } || echo "PASS  no authorized_keys"
[[ -e $M/usr/bin/socat ]] && { echo "FAIL  socat present"; fail=1; } || echo "PASS  no socat"
umount $M; rmdir $M

if [[ $fail != 0 ]]; then
  echo "== agent log from the guest console"
  grep -aE "client side|job finished|write failed|listening on" "$D/serial.log" | tail -20
fi
[[ $fail == 0 ]] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit $fail
