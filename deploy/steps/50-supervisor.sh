#!/usr/bin/env bash
# The supervisor (spec 006): build it (as the owner of the checkout), install it with the root helper that runs
# microVMs as systemd units (spec 002) and its sudoers rule, then the service. Needs host, network, runtime and image.
source "$(dirname "$0")/../lib.sh"
need_root
need_root_dir

as_builder bash "$S/supervisor/build.sh" | tail -1
[[ -x $S/build/supervisor/zerostress-supervisor ]] || { echo "the build made no supervisor binary" >&2; exit 1; }

systemctl stop zerostress-supervisor 2>/dev/null || true
# root-owned copies: zsvm runs as root through sudo, so nobody else may be able to change it
install -m 0755 -o root -g root "$S/deploy/helpers/zsvm" "$S/bin/zsvm"
install -m 0755 -o root -g root "$S/build/supervisor/zerostress-supervisor" "$S/bin/zerostress-supervisor"
restorecon "$S/bin/zsvm" "$S/bin/zerostress-supervisor" 2>/dev/null || true
put 0440 root:root /etc/sudoers.d/zerostress-vm
visudo -cqf /etc/sudoers.d/zerostress-vm

put 0644 root:root /etc/systemd/system/zerostress-supervisor.service
systemctl daemon-reload
systemctl enable zerostress-supervisor >/dev/null 2>&1
systemctl restart zerostress-supervisor
for _ in $(seq 1 50); do [[ -S $S/run/supervisor.sock ]] && break; sleep 0.2; done
say "health: $(curl -sS --max-time 5 --unix-socket "$S/run/supervisor.sock" http://localhost/v1/health)"
