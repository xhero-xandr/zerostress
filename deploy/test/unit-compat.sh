#!/usr/bin/env bash
# Is a given set of systemd hardening properties compatible with the supervisor's work under SELinux Enforcing?
# Usage (as root): unit-compat.sh LABEL PROPERTY [PROPERTY...]     e.g.  unit-compat.sh A ProtectSystem=strict ...
# Runs unit-compat-inner.sh as zerostress-sup in a transient unit with those properties, then lists AVC denials.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=${1:?label}; shift
args=(); for p in "$@"; do args+=(-p "$p"); done

T0=$(date +%s)
echo "=== variant $LABEL: $*"
systemd-run --quiet --pipe --wait --collect --unit="compat-$LABEL" -p User=zerostress-sup -p RuntimeMaxSec=120 \
  "${args[@]}" bash "$HERE/unit-compat-inner.sh"
rc=$?
echo "--- exit code: $rc"
echo "--- SELinux AVC denials since the start of this run:"
# ausearch does not work reliably here (it found nothing even by serial number), so read the logs directly,
# including the rotated file (audit.log rotates at 8 MB and rotation happened during these runs)
avc=$(cat /var/log/audit/audit.log.1 /var/log/audit/audit.log 2>/dev/null | grep -E "type=(AVC|USER_AVC)" |
  awk -v t0="$T0" 'match($0, /audit\(([0-9]+)/, m) && m[1] >= t0')
if [[ -z $avc ]]; then echo "(none)"; else
  echo "$avc" | sed -E 's/.*denied *\{ ([^}]*) \}.*comm="?([^" ]*)"?.*scontext=([^ ]*) tcontext=([^ ]*) tclass=([^ ]*).*/\2: denied { \1 } \3 -> \4 (\5)/' | sort | uniq -c | head -20
fi
exit $rc
