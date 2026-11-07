#!/usr/bin/env bash
# The host (spec 001, 010): users and groups, the project's directories with their owners and SELinux types, the
# settings files, /dev/kvm, log rotation, the kernel parameter. Idempotent. Does not touch sshd, swap or services.
source "$(dirname "$0")/../lib.sh"
need_root
need_root_dir

[[ -e /dev/kvm ]] || { echo "no /dev/kvm: Firecracker needs a machine with KVM (nested virtualisation on a VM)" >&2; exit 1; }

getent group kvm >/dev/null || groupadd -r kvm
getent group zerostress-ipc >/dev/null || groupadd -r zerostress-ipc
id zerostress-sup >/dev/null 2>&1 || useradd -r -M -d /nonexistent -s /sbin/nologin -G kvm zerostress-sup
id zerostress-web >/dev/null 2>&1 || useradd -r -M -d /nonexistent -s /sbin/nologin zerostress-web
# the owner of the code and of every build: no sudo, no login, a home of its own for the npm and go caches
id "$CODE_USER" >/dev/null 2>&1 || useradd -r -m -d /var/lib/zerostress-build -s /sbin/nologin "$CODE_USER"
getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 || useradd --system --gid caddy -M -d /nonexistent --shell /usr/sbin/nologin caddy
usermod -aG zerostress-ipc zerostress-sup
usermod -aG zerostress-ipc zerostress-web

# the project's own places (git-ignored); the code itself stays with the owner of the checkout
install -d -m 0755 -o root -g root "$S/bin" "$S/runtime" "$S/images" "$S/data" "$S/logs"
install -d -m 0750 -o zerostress-sup -g zerostress-ipc "$S/run"
install -d -m 0700 -o zerostress-sup -g zerostress-sup "$S/data/supervisor" "$S/data/supervisor/runs"
install -d -m 0700 -o zerostress-web -g zerostress-web "$S/data/web" "$S/data/web/tasks"
install -d -m 0755 -o zerostress-web -g zerostress-web "$S/data/geo"
install -d -m 0750 -o caddy -g caddy "$S/data/caddy"
# the logs hold visitors' addresses: root's only (the services write them through systemd, as root)
for n in web supervisor caddy; do [[ -e $S/logs/$n.log ]] || install -m 0600 -o root -g root /dev/null "$S/logs/$n.log"; done
chmod 0600 "$S"/logs/*.log*
own_code
selinux_rules "$S"
restorecon -R "$S"

# the settings: the only files a person edits (./zs config web|supervisor)
env_file web zerostress-web
env_file supervisor zerostress-sup

put 0644 root:root /etc/udev/rules.d/99-zerostress-kvm.rules
udevadm control --reload
udevadm trigger --action=change --subsystem-match=misc --sysname-match=kvm
udevadm settle
put 0644 root:root /etc/logrotate.d/zerostress

# Speculative store bypass is closed for seccomp-confined processes such as Firecracker's threads (the Firecracker
# production host setup). Takes effect after a reboot.
if ! grep -qw 'spec_store_bypass_disable=seccomp' /proc/cmdline; then
  if command -v grubby >/dev/null; then
    grubby --update-kernel=ALL --args=spec_store_bypass_disable=seccomp
    say "kernel: spec_store_bypass_disable=seccomp added, REBOOT the host for it to take effect"
  else
    say "kernel: add spec_store_bypass_disable=seccomp to the kernel command line by hand (no grubby here)"
  fi
fi
say "$(ls -ld "$S" | awk '{print $1, $3, $NF}') (the code is $CODE_USER's), /dev/kvm $(stat -c '%A %G' /dev/kvm)"
