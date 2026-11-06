#!/usr/bin/env bash
# The agent (web/agent, spec 008) against the real thing: the real supervisor, real microVMs, the real collector, the
# real hooks and the real model service. Like collector-e2e.sh it lays the collector over a COPY of the installed
# image, swaps it in for the duration and always puts the installed image back. Run as root on the host, after
# `npm ci --ignore-scripts` in web/ on the working copy to test, with the supervisor running and sessions enabled
# (SUP_SESSION_SLOTS=1). The key is read from /etc/zerostress/web.env and not printed. Takes a few minutes.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-e2e.sh"

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMG=/opt/zerostress/images/guest-rootfs.ext4
BACKUP=/var/tmp/zs-image-backup.ext4
NODE=/opt/node/bin/node

restore() {
  if [[ -f $BACKUP ]]; then mv -f "$BACKUP" "$IMG"; echo "installed image restored"; fi
}
trap restore EXIT

[[ -x $SRC/guest-image/agent/zerostress-agent ]] || { echo "build the agent first (guest-image/build-agent.sh)"; exit 1; }
[[ -d $SRC/web/node_modules ]] || { echo "run npm ci --ignore-scripts in web/ first"; exit 1; }
cp --sparse=always "$IMG" "$BACKUP"
bash "$SRC/guest-image/apply-overlay.sh" "$IMG" "$SRC/guest-image/agent/zerostress-agent" "$SRC/collector/collect.mjs" | tail -1
echo "real collector laid over the installed image (temporarily)"

set -a; . /etc/zerostress/web.env; set +a
out=$("$NODE" "$SRC/web/tools/e2e-agent.mjs" "$@" 2>&1); rc=$?
echo "$out"
[[ $rc == 0 ]] || fail=1
host_clean "agent e2e"
[[ $fail == 0 ]] && echo "AGENT E2E (host) OK" || echo "AGENT E2E (host) FAILED"
exit $fail
