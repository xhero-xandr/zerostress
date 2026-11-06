#!/usr/bin/env bash
# The supervisor (spec 006): build it (as the owner of the checkout), install the root helper that runs microVMs as
# systemd units with its sudoers rule (spec 002), then the binary and the service. Needs the host, network, runtime and
# image steps done first.
source "$(dirname "$0")/../lib.sh"
need_root
DEST=/opt/zerostress/supervisor
BIN=$S/build/supervisor/zerostress-supervisor

as_builder bash "$S/supervisor/build.sh" | tail -1
[[ -x $BIN ]] || { echo "the build made no supervisor binary" >&2; exit 1; }

# the root helper; zsvm itself validates every argument again
put 0755 root:root /opt/zerostress/bin/zsvm
chcon -t bin_t /opt/zerostress/bin/zsvm 2>/dev/null || true
put 0440 root:root /etc/sudoers.d/zerostress-vm
visudo -cqf /etc/sudoers.d/zerostress-vm

# code: root-owned and read-only for the service; swapped in as a whole
rm -rf "$DEST.new"
install -d -m 0755 -o root -g root "$DEST.new"
install -m 0755 -o root -g root "$BIN" "$DEST.new/zerostress-supervisor"
systemctl stop zerostress-supervisor 2>/dev/null || true
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

put 0644 root:root /etc/systemd/system/zerostress-supervisor.service
systemctl daemon-reload
systemctl enable zerostress-supervisor >/dev/null 2>&1
systemctl restart zerostress-supervisor
for _ in $(seq 1 50); do [[ -S /run/zerostress/supervisor.sock ]] && break; sleep 0.2; done
say "health: $(curl -sS --max-time 5 --unix-socket /run/zerostress/supervisor.sock http://localhost/v1/health)"
