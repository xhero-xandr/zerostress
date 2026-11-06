#!/usr/bin/env bash
# Shared by the image tests (image-*.sh): boot one microVM (network slot 0) from the installed image with the stub
# collector (or COLLECTOR_ENTRY=...), talk to its agent through the vsock socket, clean up on exit. Source it, do not run it. Run as root.
# The caller sets `set -uo pipefail`.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE=/opt/node/bin/node
SUP=zerostress-sup
fail=0

q() { sudo -u $SUP sudo -n /opt/zerostress/bin/zsnet "$@"; }

vm_cleanup() {
  systemctl stop "$UNIT" 2>/dev/null
  q down 0 2>/dev/null
  rm -rf "$D"
}

# vm_boot NAME [BASE_IMAGE] [AGENT_BIN] [VM_MEM_MIB]
vm_boot() {
  local name=$1
  local base=${2:-/opt/zerostress/images/guest-rootfs.ext4}
  local agent=${3:-$HERE/../../build/guest-agent/zerostress-agent}
  local mem=${4:-1024}
  D=/var/lib/zerostress/runs/$name
  UNIT=fc-$name
  UDS=$D/v.sock
  trap vm_cleanup EXIT
  vm_cleanup

  install -d -m 0700 -o $SUP -g $SUP "$D"
  echo "== copy + overlay"
  local t
  t=$(date +%s.%N); cp --sparse=always "$base" "$D/rootfs.ext4"
  printf 'copy %.2fs\n' "$(awk -v a="$(date +%s.%N)" -v b="$t" "BEGIN{print a-b}")"
  bash "$HERE/../../guest/image/apply-overlay.sh" "$D/rootfs.ext4" "$agent" "${COLLECTOR_ENTRY:-$HERE/stub-collector.mjs}" | tail -2
  [[ ${PIPESTATUS[0]} == 0 ]] || { echo "overlay failed"; exit 1; }
  chown $SUP:$SUP "$D/rootfs.ext4"; chmod 0600 "$D/rootfs.ext4"

  cat >"$D/vm.json" <<J
{"boot-source":{"kernel_image_path":"/opt/zerostress/images/vmlinux-6.18.56",
  "boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off:1.1.1.1"},
 "drives":[{"drive_id":"rootfs","path_on_host":"$D/rootfs.ext4","is_root_device":true,"is_read_only":false}],
 "network-interfaces":[{"iface_id":"net1","guest_mac":"06:00:AC:10:00:02","host_dev_name":"zstap0"}],
 "vsock":{"guest_cid":3,"uds_path":"$UDS"},
 "machine-config":{"vcpu_count":2,"mem_size_mib":$mem}}
J
  chown $SUP:$SUP "$D/vm.json"

  echo "== boot"
  q up 0 || exit 1
  local t0 ready=0 i
  t0=$(date +%s.%N)
  systemd-run -q --collect --unit=$UNIT -p User=$SUP -p RuntimeMaxSec=300 \
    -p StandardOutput=file:$D/serial.log -p StandardError=file:$D/err.log \
    /opt/zerostress/bin/firecracker --no-api --config-file "$D/vm.json"

  for i in $(seq 1 60); do
    if sudo -u $SUP $NODE "$HERE/vsock-client.mjs" --probe "$UDS" 5000 '{}' 2>/dev/null; then ready=1; break; fi
    sleep 0.25
  done
  printf 'agent ready after %.1fs (ready=%s)\n' "$(awk -v a="$(date +%s.%N)" -v b="$t0" "BEGIN{print a-b}")" "$ready"
  [[ $ready == 1 ]] || { tail -30 "$D/serial.log"; exit 1; }
}

# run JOB [COMMAND...] [--flags]: one agent connection, the streamed lines on stdout, client notes in $D/c.err
run() {
  local job=$1; shift
  local flags=() cmds=() a
  for a in "$@"; do if [[ $a == --* ]]; then flags+=("$a"); else cmds+=("$a"); fi; done
  sudo -u $SUP $NODE "$HERE/vsock-client.mjs" "${flags[@]}" "$UDS" 5000 "$job" "${cmds[@]}" 2>"$D/c.err"
}

check() { # name, output, regex
  if grep -qE "$3" <<<"$2"; then echo "PASS  $1"; else echo "FAIL  $1"; echo "$2" | cut -c1-300 | head -5; fail=1; fi
}
