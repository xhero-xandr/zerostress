#!/usr/bin/env bash
# Apply the ZeroStress overlay to a guest root filesystem image (spec 004).
# Usage: apply-overlay.sh IMAGE AGENT_BIN COLLECTOR_JS
# Works on a COPY of the image: it modifies IMAGE in place. Run as root.
set -euo pipefail
export LC_ALL=C

IMG=${1:?image}; AGENT=${2:?agent binary}; COLLECTOR=${3:?collector entry}
HERE=$(cd "$(dirname "$0")" && pwd)
M=$(mktemp -d)
cleanup() { mountpoint -q "$M" && umount "$M"; rmdir "$M" 2>/dev/null || true; }
trap cleanup EXIT

e2fsck -fp "$IMG" >/dev/null || [[ $? -le 1 ]]
mount -o loop "$IMG" "$M"

# agent + unit, enabled by symlink (no chroot needed)
install -m 0755 -o root -g root "$AGENT" "$M/usr/local/bin/zerostress-agent"
install -m 0644 -o root -g root "$HERE/overlay/zerostress-agent.service" "$M/etc/systemd/system/zerostress-agent.service"
mkdir -p "$M/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/zerostress-agent.service "$M/etc/systemd/system/multi-user.target.wants/zerostress-agent.service"

# collector entry point (root-owned; the unprivileged user can read but not modify it)
install -d -m 0755 -o root -g root "$M/opt/collector"
install -m 0644 -o root -g root "$COLLECTOR" "$M/opt/collector/collect.mjs"

# DNS: static public resolvers (variant A in spec 003)
rm -f "$M/etc/resolv.conf"
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' >"$M/etc/resolv.conf"
chmod 0644 "$M/etc/resolv.conf"
rm -f "$M/etc/systemd/system/multi-user.target.wants/systemd-resolved.service" \
      "$M/etc/systemd/system/dbus-org.freedesktop.resolve1.service"
ln -sf /dev/null "$M/etc/systemd/system/systemd-resolved.service"

# no SSH in the guest: the only channel is vsock. Remove host keys, authorized keys and the CI network helper.
for u in ssh.service ssh.socket sshd.service; do ln -sf /dev/null "$M/etc/systemd/system/$u"; done
rm -f "$M"/etc/ssh/ssh_host_* "$M/root/.ssh/authorized_keys"
rm -rf "$M/home/ubuntu/.ssh" "$M/home/pw/.ssh"
rm -f "$M/etc/systemd/system/fcnet.service" "$M/usr/local/bin/fcnet-setup.sh"

# leftovers of the CI image that a job has no use for
rm -rf "$M"/usr/local/bin/{devmemread,devmemread.c,fast_page_fault_helper,fast_page_fault_helper.c,fillmem,fillmem.c,go_sdk_cred_provider,go_sdk_cred_provider.go}
rm -f "$M/usr/bin/socat" "$M/usr/bin/socat1" "$M/usr/bin/filan" "$M/usr/bin/procan"

umount "$M"
e2fsck -fn "$IMG" >/dev/null
echo "overlay applied: $IMG"
sha256sum "$IMG"
