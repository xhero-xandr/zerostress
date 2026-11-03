#!/usr/bin/env bash
# Host baseline per docs/specs/001-host-baseline.md (sections 4.1-4.3, 4.4a). Idempotent. Run as root.
# Does NOT touch sshd, swap, firewalld or services.
set -euo pipefail

SRC="${SRC:-/home/linuxuser/fc-test}"

# 4.1 users and groups
getent group kvm >/dev/null || groupadd -r kvm
getent group zerostress-ipc >/dev/null || groupadd -r zerostress-ipc
id zerostress-sup >/dev/null 2>&1 || useradd -r -m -d /var/lib/zerostress -s /sbin/nologin -G kvm zerostress-sup
id zerostress-web >/dev/null 2>&1 || useradd -r -M -d /nonexistent -s /sbin/nologin zerostress-web
usermod -aG zerostress-ipc zerostress-sup
usermod -aG zerostress-ipc zerostress-web

# 4.2 directories
install -d -m 0755 -o root -g root /opt/zerostress /opt/zerostress/bin /opt/zerostress/images
install -d -m 0700 -o zerostress-sup -g zerostress-sup /var/lib/zerostress/runs
install -d -m 0750 -o zerostress-sup -g zerostress-ipc /run/zerostress

# artifacts (read-only for services)
install -m 0755 -o root -g root "$SRC/firecracker" /opt/zerostress/bin/firecracker
install -m 0644 -o root -g root "$SRC/vmlinux-6.18.56" /opt/zerostress/images/vmlinux-6.18.56
install -m 0644 -o root -g root "$SRC/chromium.ext4" /opt/zerostress/images/guest-base.ext4

# 4.4a SELinux labels
if command -v semanage >/dev/null; then
  semanage fcontext -a -t bin_t '/opt/zerostress/bin(/.*)?' 2>/dev/null || semanage fcontext -m -t bin_t '/opt/zerostress/bin(/.*)?'
  restorecon -R /opt/zerostress
fi

# 4.3 /dev/kvm: 0660 root:kvm
cat >/etc/udev/rules.d/99-zerostress-kvm.rules <<'EOF'
KERNEL=="kvm", GROUP="kvm", MODE="0660"
EOF
udevadm control --reload
udevadm trigger --action=change --subsystem-match=misc --sysname-match=kvm
udevadm settle

echo "--- result"
ls -l /dev/kvm
id zerostress-sup; id zerostress-web
ls -ldZ /opt/zerostress/bin /opt/zerostress/images /var/lib/zerostress/runs /run/zerostress
/opt/zerostress/bin/firecracker --version | head -1
