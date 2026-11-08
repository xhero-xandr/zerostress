#!/usr/bin/env bash
# What an escape into the Firecracker process could reach (review C1). Runs a probe in exactly the unit sandbox zsvm
# gives Firecracker (its unit_props), with a run directory prepared the way the supervisor prepares one, and asks:
# the supervisor's API socket, another VM's run directory, the supervisor's state and settings, the supervisor's process
# (seen, signalled, its root walked through /proc), the checkout. Positive controls: what Firecracker needs still works.
# Run as root on the host. Safe next to live VMs: the probe has no network and no ExecStopPost (no "zsnet down").
#   deploy/test/zsvm-isolation.sh [SLOT]        (default 3; the zsvm under test: ZSVM=..., default deploy/helpers/zsvm)
set -uo pipefail
ZSVM=${ZSVM:-/zerostress/deploy/helpers/zsvm}
SLOT=${1:-3}
OTHER=$(( (SLOT + 1) % 4 ))
ID=33333333-4444-4555-8666-77777777777$SLOT
SIB=33333333-4444-4555-8666-88888888888$SLOT
KERNEL=$(ls /zerostress/images/vmlinux-* | head -1)
UNIT=zsvm-isolation-probe
fail=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1${2:+: $2}"; fail=1; }

# shellcheck source=../helpers/zsvm
source "$ZSVM"
set +e
DIR=$RUNS/$ID
SIBDIR=$RUNS/$SIB
cleanup() { systemctl stop $UNIT 2>/dev/null; systemctl reset-failed $UNIT 2>/dev/null; rm -rf "$DIR" "$SIBDIR"; }
trap cleanup EXIT
cleanup

# the group a slot's files belong to (from C1 on); before it, the supervisor's own
grp() { getent group "zerostress-vm$1" >/dev/null && echo "zerostress-vm$1" || echo "$SUPUSER"; }
install -d -m 0770 -o "$SUPUSER" -g "$(grp "$SLOT")" "$DIR"
install -m 0660 -o "$SUPUSER" -g "$(grp "$SLOT")" /dev/null "$DIR/scratch.ext4"
truncate -s 1M "$DIR/scratch.ext4"
# another VM's run directory, as the supervisor leaves it for the VM of another slot
install -d -m 0770 -o "$SUPUSER" -g "$(grp "$OTHER")" "$SIBDIR"
install -m 0660 -o "$SUPUSER" -g "$(grp "$OTHER")" /dev/null "$SIBDIR/secret"
echo other-vm >"$SIBDIR/secret"

unit_props "$SLOT" "$ID" "$DIR" 1024 2
# drop ExecStopPost: "zsnet down" would take a live VM's network away
props=()
for ((i = 0; i < ${#PROPS[@]}; i++)); do
  if [[ ${PROPS[i]} == -p && ${PROPS[i+1]} == ExecStopPost=* ]]; then i=$((i + 1)); continue; fi
  props+=("${PROPS[i]}")
done

SUPPID=$(systemctl show -p MainPID --value zerostress-supervisor)
[[ $SUPPID =~ ^[1-9][0-9]*$ ]] || { echo "FAIL  the supervisor is not running (MainPID '$SUPPID')"; exit 1; }

# shellcheck disable=SC2016
probe='
r() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
echo "user $(id -un)"
echo "sup_api $(r curl -sf --max-time 3 --unix-socket /zerostress/run/supervisor.sock http://localhost/v1/health)"
echo "other_run $(r cat "$3/secret")"
echo "other_run_list $(r ls "$3")"
echo "sup_state $(r ls /zerostress/data/supervisor/records)"
echo "sup_db $(r head -c1 /zerostress/data/supervisor/supervisor.db)"
echo "sup_config $(r cat /zerostress/config/supervisor.env)"
echo "web_config $(r cat /zerostress/config/web.env)"
echo "sup_proc $(r test -e "/proc/$1/cmdline")"
echo "sup_signal $(r kill -0 "$1")"
echo "sup_root $(r ls "/proc/$1/root/")"
echo "logs $(r ls /zerostress/logs)"
echo "code $(r ls /zerostress/web)"
echo "own_write $(r touch "$2/probe")"
echo "own_scratch $(r bash -c "exec 3<>\"$2/scratch.ext4\"")"
echo "kvm $(r bash -c "exec 3<>/dev/kvm")"
echo "tun $(r bash -c "exec 3<>/dev/net/tun")"
echo "kernel $(r head -c1 "$4")"
echo "image $(r head -c1 /zerostress/images/guest-rootfs.ext4)"
echo "image_write $(r bash -c "exec 3<>/zerostress/images/guest-rootfs.ext4")"
echo "firecracker $(r test -x /zerostress/bin/firecracker)"
'
out=$(systemd-run --quiet --pipe --wait --collect --unit=$UNIT "${props[@]}" /usr/bin/bash -c "$probe" probe "$SUPPID" "$DIR" "$SIBDIR" "$KERNEL" 2>&1)
get() { awk -v k="$1" '$1 == k { print $2 }' <<<"$out"; }
[[ -n $(get user) ]] || { echo "FAIL  the probe did not run: $out"; exit 1; }

want=zerostress-vm$SLOT
[[ $(get user) == "$want" ]] && ok "Firecracker runs as $want, not as the supervisor" || bad "Firecracker's user" "$(get user), wanted $want"
for k in sup_api other_run other_run_list sup_state sup_db sup_config web_config sup_proc sup_signal sup_root logs code image_write; do
  [[ $(get $k) == no ]] && ok "out of reach: $k" || bad "reachable from Firecracker's sandbox: $k" "$(get $k)"
done
for k in own_write own_scratch image kvm tun kernel firecracker; do
  [[ $(get $k) == yes ]] && ok "still works: $k" || bad "Firecracker needs it and lost it: $k" "$(get $k)"
done
echo
((fail == 0)) && echo "zsvm isolation: ALL PASS" || echo "zsvm isolation: FAILED"
exit $fail
