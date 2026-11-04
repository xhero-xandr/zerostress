#!/usr/bin/env bash
# Install and (re)start the supervisor service (spec 006). Idempotent. Run as root on the host, after
# 001-host-baseline.sh, 003-network.sh and the guest image installation. Build the binary first, as an unprivileged
# user: supervisor/build.sh.
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd)
DEST=/opt/zerostress/supervisor
BIN=$S/supervisor/zerostress-supervisor
[[ -x $BIN ]] || { echo "build the supervisor first (supervisor/build.sh)"; exit 1; }

# the root helper that runs microVMs as systemd units (and its sudoers rule)
bash "$S/deploy/002-vm-runner.sh" >/dev/null

# code: root-owned and read-only for the service; swapped in as a whole
rm -rf "$DEST.new"
install -d -m 0755 -o root -g root "$DEST.new"
install -m 0755 -o root -g root "$BIN" "$DEST.new/zerostress-supervisor"
systemctl stop zerostress-supervisor 2>/dev/null || true
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

install -m 0644 -o root -g root "$S/deploy/zerostress-supervisor.service" /etc/systemd/system/zerostress-supervisor.service
systemctl daemon-reload
systemctl enable zerostress-supervisor >/dev/null 2>&1
systemctl restart zerostress-supervisor

for _ in $(seq 1 50); do
  [[ -S /run/zerostress/supervisor.sock ]] && break
  sleep 0.2
done
curl -sS --max-time 5 --unix-socket /run/zerostress/supervisor.sock http://localhost/v1/health
echo
systemctl --no-pager --lines=0 status zerostress-supervisor | sed -n '1,4p'
ls -l /run/zerostress/supervisor.sock
