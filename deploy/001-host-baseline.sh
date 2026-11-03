#!/usr/bin/env bash
# Host baseline per docs/specs/001-host-baseline.md (sections 4.1-4.3, 4.4a). Idempotent. Run as root.
# Does NOT touch sshd, swap, firewalld or services.
set -euo pipefail

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

# service environment files (secrets live only here, on the host). Created once, never overwritten.
install -d -m 0755 -o root -g root /etc/zerostress
if [[ ! -e /etc/zerostress/web.env ]]; then
  cat >/etc/zerostress/web.env <<'EOF'
# Environment of zerostress-web. Fill in INFERENCE_API_KEY and INFERENCE_MODEL; do not commit or paste this file anywhere.
INFERENCE_BASE_URL=https://api.vultrinference.com/v1
INFERENCE_API_KEY=
INFERENCE_MODEL=
# auto | vision | text | rules-only
AGENT_MODE=auto
EOF
  chown root:zerostress-web /etc/zerostress/web.env
  chmod 0640 /etc/zerostress/web.env
fi
if [[ ! -e /etc/zerostress/supervisor.env ]]; then
  cat >/etc/zerostress/supervisor.env <<'EOF'
# Environment of zerostress-supervisor (no secrets). Defaults are in docs/specs/006-supervisor-api.md.
SUP_CONCURRENCY=2
EOF
  chown root:zerostress-sup /etc/zerostress/supervisor.env
  chmod 0640 /etc/zerostress/supervisor.env
fi

# /run is tmpfs: recreate the socket directory at every boot
cat >/etc/tmpfiles.d/zerostress.conf <<'EOF'
d /run/zerostress 0750 zerostress-sup zerostress-ipc -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/zerostress.conf

# Firecracker: official release, pinned checksum (published next to the tarball)
FC_VERSION=v1.17.0
FC_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
T=$(mktemp -d)
curl -fsSL --retry 3 -o "$T/fc.tgz" "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz"
echo "$FC_SHA256  $T/fc.tgz" | sha256sum -c -
tar -xzf "$T/fc.tgz" -C "$T"
install -m 0755 -o root -g root "$T/release-$FC_VERSION-x86_64/firecracker-$FC_VERSION-x86_64" /opt/zerostress/bin/firecracker
rm -rf "$T"
# kernel and guest image are installed by guest-image/install.sh after guest-image/build.sh

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
