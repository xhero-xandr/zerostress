#!/usr/bin/env bash
# Install and (re)start the supervisor service (spec 006). Idempotent. Run as root on the host, after
# 001-host-baseline.sh, 003-network.sh and the guest image installation.
# IMPL=ts (default): the TypeScript reference, no npm dependencies. IMPL=go: the Go implementation; build it first
# (supervisor-go/build.sh). Both run as the same service, so one replaces the other and the same tests apply.
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd)
IMPL=${IMPL:-ts}

# the root helper that runs microVMs as systemd units (and its sudoers rule)
bash "$S/deploy/002-vm-runner.sh" >/dev/null

case $IMPL in
  ts)
    DEST=/opt/zerostress/supervisor
    UNIT=$S/deploy/zerostress-supervisor.service
    ;;
  go)
    DEST=/opt/zerostress/supervisor-go
    UNIT=$S/deploy/zerostress-supervisor-go.service
    [[ -x $S/supervisor-go/zerostress-supervisor ]] || { echo "build supervisor-go first (supervisor-go/build.sh)"; exit 1; }
    ;;
  *) echo "IMPL must be ts or go"; exit 1 ;;
esac

# code: root-owned and read-only for the service; swapped in as a whole
rm -rf "$DEST.new"
install -d -m 0755 -o root -g root "$DEST.new"
if [[ $IMPL == ts ]]; then
  cp -r "$S/supervisor/src" "$S/supervisor/package.json" "$DEST.new/"
else
  install -m 0755 -o root -g root "$S/supervisor-go/zerostress-supervisor" "$DEST.new/zerostress-supervisor"
fi
chown -R root:root "$DEST.new"
chmod -R go-w "$DEST.new"
systemctl stop zerostress-supervisor 2>/dev/null || true
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

install -m 0644 -o root -g root "$UNIT" /etc/systemd/system/zerostress-supervisor.service
systemctl daemon-reload
systemctl enable zerostress-supervisor >/dev/null 2>&1
systemctl restart zerostress-supervisor

for _ in $(seq 1 50); do
  [[ -S /run/zerostress/supervisor.sock ]] && break
  sleep 0.2
done
echo "implementation: $IMPL"
curl -sS --max-time 5 --unix-socket /run/zerostress/supervisor.sock http://localhost/v1/health
echo
systemctl --no-pager --lines=0 status zerostress-supervisor | sed -n '1,4p'
ls -l /run/zerostress/supervisor.sock
