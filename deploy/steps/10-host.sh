#!/usr/bin/env bash
# Host baseline (spec 001, 4.1-4.4a): users and groups, directories, the environment files, /run after reboot,
# /dev/kvm, SELinux labels, the kernel parameter. Idempotent. Does not touch sshd, swap, firewalld or services.
source "$(dirname "$0")/../lib.sh"
need_root

[[ -e /dev/kvm ]] || { echo "no /dev/kvm: Firecracker needs a machine with KVM (nested virtualisation on a VM)" >&2; exit 1; }

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
install -d -m 0755 -o root -g root /etc/zerostress

# the environment of the services: the only files a person edits on the host (spec 010, 4.3)
env_file web zerostress-web
env_file supervisor zerostress-sup

# /run is tmpfs: the socket directory is made again at every boot
put 0644 root:root /etc/tmpfiles.d/zerostress.conf
systemd-tmpfiles --create /etc/tmpfiles.d/zerostress.conf

# 4.4a SELinux labels for the helpers and Firecracker
if command -v semanage >/dev/null; then
  semanage fcontext -a -t bin_t '/opt/zerostress/bin(/.*)?' 2>/dev/null || semanage fcontext -m -t bin_t '/opt/zerostress/bin(/.*)?'
  restorecon -R /opt/zerostress
fi

# 4.3 /dev/kvm: 0660 root:kvm
put 0644 root:root /etc/udev/rules.d/99-zerostress-kvm.rules
udevadm control --reload
udevadm trigger --action=change --subsystem-match=misc --sysname-match=kvm
udevadm settle

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

ls -l /dev/kvm | sed 's/^/  /'
