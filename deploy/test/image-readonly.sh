#!/usr/bin/env bash
# The read-only image and the scratch disk (review D3), on a real microVM, without a network and outside the service's
# slots (it can run next to live checks): the image is attached read-only, zerostress-init lays an empty scratch disk
# over it, systemd and the agent come up, the guest writes only to the scratch disk, and the image is the same bytes
# after the run. Run as root on the host:
#   deploy/test/image-readonly.sh [IMAGE]       (default: build/image/out/guest-rootfs.ext4, the image just built)
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMG=${1:-$HERE/../../build/image/out/guest-rootfs.ext4}
KERNEL=$(ls /zerostress/images/vmlinux-* | head -1)
NODE=/zerostress/runtime/node/bin/node
SUP=zerostress-sup
D=/zerostress/data/supervisor/runs/image-readonly
UNIT=fc-image-readonly
UDS=$D/v.sock
SCRATCH_MIB=256
fail=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1${2:+: $2}"; fail=1; }
cleanup() { systemctl stop "$UNIT" 2>/dev/null; systemctl reset-failed "$UNIT" 2>/dev/null; rm -rf "${D:?}"; }
trap cleanup EXIT
cleanup

[[ -f $IMG ]] || { echo "no image at $IMG"; exit 1; }
before=$(sha256sum "$IMG" | awk '{print $1}')
install -d -m 0700 -o $SUP -g $SUP "$D"
sudo -u $SUP truncate -s ${SCRATCH_MIB}M "$D/scratch.ext4"
cat >"$D/vm.json" <<J
{"boot-source":{"kernel_image_path":"$KERNEL",
  "boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/usr/local/sbin/zerostress-init"},
 "drives":[{"drive_id":"rootfs","path_on_host":"$(readlink -f "$IMG")","is_root_device":true,"is_read_only":true},
           {"drive_id":"scratch","path_on_host":"$D/scratch.ext4","is_root_device":false,"is_read_only":false}],
 "vsock":{"guest_cid":3,"uds_path":"$UDS"},
 "machine-config":{"vcpu_count":2,"mem_size_mib":1024}}
J
chown $SUP:$SUP "$D/vm.json"

t0=$(date +%s.%N)
systemd-run -q --collect --unit=$UNIT -p User=$SUP -p SupplementaryGroups=kvm -p RuntimeMaxSec=120 \
  -p StandardOutput=file:$D/serial.log -p StandardError=file:$D/err.log \
  /zerostress/bin/firecracker --no-api --config-file "$D/vm.json"
ready=0
for _ in $(seq 1 80); do
  if sudo -u $SUP $NODE "$HERE/vsock-client.mjs" --probe "$UDS" 5000 '{}' 2>/dev/null; then ready=1; break; fi
  sleep 0.25
done
took=$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.1f", a-b}')
if [[ $ready == 1 ]]; then ok "the guest booted over its scratch disk; the agent answers after ${took}s"; else bad "the guest did not come up" "$(tail -20 "$D/serial.log")"; exit 1; fi

serial=$(cat "$D/serial.log")
grep -q 'zerostress-init\|EXT4-fs (vdb)' <<<"$serial" && ok "the scratch disk was formatted and mounted at boot" || bad "no sign of the scratch disk in the console"
grep -qE 'EXT4-fs \(vda\): mounted filesystem .* ro' <<<"$serial" && ok "the image is mounted read-only" || bad "the image was not mounted read-only" "$(grep 'vda' <<<"$serial" | head -3)"
grep -q 'overlayfs' <<<"$serial" && bad "overlayfs complained" "$(grep overlayfs <<<"$serial" | head -3)" || ok "overlayfs said nothing"

used=$(( $(stat -c %b "$D/scratch.ext4") * 512 / 1024 ))
(( used > 0 && used <= SCRATCH_MIB * 1024 )) && ok "the guest's writes went to the scratch disk (${used} KiB on the host, at most ${SCRATCH_MIB} MiB)" || bad "scratch disk use" "${used} KiB"

systemctl stop "$UNIT" 2>/dev/null
after=$(sha256sum "$IMG" | awk '{print $1}')
[[ $after == "$before" ]] && ok "the image is the same bytes after the run" || bad "the image changed" "$before -> $after"

echo
((fail == 0)) && echo "image read-only: ALL PASS" || echo "image read-only: FAILED"
exit $fail
