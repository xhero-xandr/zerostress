#!/usr/bin/env bash
# Network isolation with two simultaneous guests (spec 003, section 7). Run as root on the host.
# Usage: net-isolation.sh [IMAGE] [AGENT_BIN]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=${1:-/opt/zerostress/images/guest-rootfs.ext4}
AGENT=${2:-$HERE/../agent/zerostress-agent}
D=/var/lib/zerostress/runs/netiso
NODE=/opt/node/bin/node
SUP=zerostress-sup
fail=0

q() { sudo -u $SUP sudo -n /opt/zerostress/bin/zsnet "$@"; }
cleanup() { for n in 0 1; do systemctl stop fc-netiso$n 2>/dev/null; q down $n 2>/dev/null; done; rm -rf "$D"; }
trap cleanup EXIT
cleanup
install -d -m 0700 -o $SUP -g $SUP "$D"

boot() { # slot cid
  local n=$1 cid=$2
  cp --sparse=always "$BASE" "$D/rootfs$n.ext4"
  bash "$HERE/../apply-overlay.sh" "$D/rootfs$n.ext4" "$AGENT" "$HERE/stub-collector.mjs" >/dev/null || exit 1
  chown $SUP:$SUP "$D/rootfs$n.ext4"; chmod 0600 "$D/rootfs$n.ext4"
  cat >"$D/vm$n.json" <<J
{"boot-source":{"kernel_image_path":"/opt/zerostress/images/vmlinux-6.18.56",
  "boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.$n.2::172.16.$n.1:255.255.255.252::eth0:off:1.1.1.1"},
 "drives":[{"drive_id":"rootfs","path_on_host":"$D/rootfs$n.ext4","is_root_device":true,"is_read_only":false}],
 "network-interfaces":[{"iface_id":"net1","guest_mac":"06:00:AC:10:0$n:02","host_dev_name":"zstap$n"}],
 "vsock":{"guest_cid":$cid,"uds_path":"$D/v$n.sock"},
 "machine-config":{"vcpu_count":1,"mem_size_mib":768}}
J
  chown $SUP:$SUP "$D/vm$n.json"
  q up $n || exit 1
  systemd-run -q --collect --unit=fc-netiso$n -p User=$SUP -p RuntimeMaxSec=180 \
    -p StandardOutput=file:$D/serial$n.log -p StandardError=file:$D/err$n.log \
    /opt/zerostress/bin/firecracker --no-api --config-file "$D/vm$n.json"
  for i in $(seq 1 80); do
    sudo -u $SUP $NODE "$HERE/vsock-client.mjs" "$D/v$n.sock" 5000 '{}' --probe 2>/dev/null && return 0
    sleep 0.25
  done
  echo "guest $n did not become ready"; exit 1
}
run() { sudo -u $SUP $NODE "$HERE/vsock-client.mjs" "$D/v$1.sock" 5000 "$2" 2>/dev/null; }
counter() { nft list chain inet zerostress guest_fwd | grep "$1" | grep -o 'packets [0-9]*' | head -1 | cut -d' ' -f2; }
check() { if grep -qE "$3" <<<"$2"; then echo "PASS  $1"; else echo "FAIL  $1"; echo "$2" | cut -c1-200 | head -3; fail=1; fi; }

echo "== boot two guests"; boot 0 3; boot 1 4; echo "both ready"

before=$(counter "guest to guest")
out=$(run 0 '{"mode":"fetch","url":"http://172.16.1.2:8080/","timeout_ms":3000}')
check "guest0 -> guest1 fails" "$out" '"kind":"error"'
after=$(counter "guest to guest")
[[ $after -gt $before ]] && echo "PASS  'guest to guest' rule counted $((after-before)) packets" || { echo "FAIL  guest-to-guest counter did not move ($before -> $after)"; fail=1; }

before=$(counter "internal, metadata")
out=$(run 1 '{"mode":"fetch","url":"http://10.0.0.1.nip.io/","timeout_ms":4000}')
check "name resolving to 10.0.0.1: connection fails" "$out" '"kind":"error"'
grep -q ENOTFOUND <<<"$out" && { echo "INCONCLUSIVE  DNS lookup failed (ENOTFOUND)"; fail=1; }
after=$(counter "internal, metadata")
[[ $after -gt $before ]] && echo "PASS  'internal' rule dropped $((after-before)) packets for the rebinding-style name" || { echo "FAIL  internal counter did not move ($before -> $after)"; fail=1; }

out=$(run 0 '{"mode":"fetch","url":"http://[2606:4700:4700::1111]/","timeout_ms":3000}')
check "IPv6 target fails" "$out" '"kind":"error"'

out=$(run 0 '{"mode":"fetch","url":"https://example.com"}'); check "guest0 still reaches the internet" "$out" '"status":200'
out=$(run 1 '{"mode":"fetch","url":"https://example.com"}'); check "guest1 still reaches the internet" "$out" '"status":200'

echo "== cleanup check"
q down 0; q down 1; systemctl stop fc-netiso0 fc-netiso1 2>/dev/null
ip -br link | grep -q zstap && { echo "FAIL  zstap left"; fail=1; } || echo "PASS  no zstap after down"
nft list set inet zerostress slots | grep -q zstap && { echo "FAIL  slot elements left"; fail=1; } || echo "PASS  slots set empty"
[[ $fail == 0 ]] && echo "NET ISOLATION OK" || echo "NET ISOLATION FAILED"
exit $fail
