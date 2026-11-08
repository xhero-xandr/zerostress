#!/usr/bin/env bash
# The zsvm root helper must refuse everything except exact, valid requests, and only from zerostress-sup. Run as root.
set -uo pipefail
ZSVM=/zerostress/bin/zsvm
RUNS=/zerostress/data/supervisor/runs
GOOD=11111111-2222-4333-8444-555555555555
fail=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1${2:+: $2}"; fail=1; }
asup() { sudo -u zerostress-sup sudo -n "$ZSVM" "$@" 2>&1; echo "rc=$?"; }
refused() { # name, args...  (the helper exits with 2 and a message, or sudo refuses)
  local name=$1; shift; local out; out=$(asup "$@")
  [[ $out =~ rc=(2|1)$ && ! $out =~ rc=0 ]] && ok "$name" || bad "$name" "$out"
}

cleanup() { rm -rf "$RUNS/$GOOD" "$RUNS/22222222-3333-4444-8555-666666666666"; }
trap cleanup EXIT
cleanup

echo "== argument validation (as zerostress-sup, through sudo)"
install -d -m 0700 -o zerostress-sup -g zerostress-sup "$RUNS/$GOOD"
refused "slot 4 refused"                 run 4 $GOOD 1024 2
refused "slot -1 refused"                run -1 $GOOD 1024 2
refused "slot 1;id refused"              run '1;id' $GOOD 1024 2
refused "run id not a UUID refused"      run 0 not-a-uuid 1024 2
refused "run id with path refused"       run 0 ../../etc/passwd 1024 2
refused "memory too small refused"       run 0 $GOOD 100 2
refused "memory too large refused"       run 0 $GOOD 999999 2
refused "memory not a number refused"    run 0 $GOOD 1g 2
refused "vcpu 9 refused"                 run 0 $GOOD 1024 9
refused "extra argument refused"         run 0 $GOOD 1024 2 extra
refused "missing arguments refused"      run 0 $GOOD
refused "unknown command refused"        wipe
refused "stop with a bad id refused"     stop ../../x
refused "stop with no id refused"        stop
refused "recover with arguments refused" recover now
rm -rf "$RUNS/$GOOD"
refused "missing run directory refused"  run 0 $GOOD 1024 2
S=22222222-3333-4444-8555-666666666666
ln -s /tmp "$RUNS/$S"
refused "symlinked run directory refused" run 0 $S 1024 2
rm -f "$RUNS/$S"
install -d -m 0700 "$RUNS/$S"   # owned by root, not by the supervisor user
refused "run directory with the wrong owner refused" run 0 $S 1024 2
rm -rf "$RUNS/$S"
# a directory the supervisor has not handed to the slot (review C1): Firecracker would run as zerostress-vm0 on it
handed() { # dir-group dir-mode disk-group disk-mode
  rm -rf "$RUNS/$S"; install -d -m "$2" -o zerostress-sup -g "$1" "$RUNS/$S"
  install -m "$4" -o zerostress-sup -g "$3" /dev/null "$RUNS/$S/scratch.ext4"
}
handed zerostress-sup 0700 zerostress-sup 0600
refused "run directory not handed to the slot refused"     run 0 $S 1024 2
handed zerostress-vm1 0770 zerostress-vm1 0660
refused "run directory of another slot refused"            run 0 $S 1024 2
handed zerostress-vm0 0777 zerostress-vm0 0660
refused "run directory open to everyone refused"           run 0 $S 1024 2
handed zerostress-vm0 0770 zerostress-sup 0660
refused "disk not handed to the slot refused"              run 0 $S 1024 2
handed zerostress-vm0 0770 zerostress-vm0 0660
rm -f "$RUNS/$S/scratch.ext4"; ln -s /etc/shadow "$RUNS/$S/scratch.ext4"
refused "symlinked disk refused"                           run 0 $S 1024 2
rm -f "$RUNS/$S/scratch.ext4"; ln /etc/hostname "$RUNS/$S/scratch.ext4" 2>/dev/null || true
[[ -e $RUNS/$S/scratch.ext4 ]] && refused "hard-linked disk refused" run 0 $S 1024 2
rm -rf "$RUNS/$S"

echo "== harmless commands work"
out=$(asup stop $GOOD); [[ $out =~ rc=0$ ]] && ok "stop of an unknown unit is a no-op" || bad "stop no-op" "$out"
out=$(asup recover);    [[ $out =~ rc=0$ ]] && ok "recover with nothing to do" || bad "recover" "$out"

echo "== who may call the helper"
# linuxuser is the administrator account with "(ALL) NOPASSWD: ALL", so it can run anything by design
for u in zerostress-web nobody; do
  out=$(sudo -u $u sudo -n "$ZSVM" recover 2>&1; echo "rc=$?")
  [[ ! $out =~ rc=0$ ]] && ok "$u is refused" || bad "$u is refused" "$out"
done
[[ $(stat -c '%U:%a' "$ZSVM") == root:755 ]] && ok "helper is root-owned and not writable" || bad "helper permissions" "$(stat -c '%U:%a' "$ZSVM")"

[[ $fail == 0 ]] && echo "ZSVM HELPER OK" || echo "ZSVM HELPER FAILED"
exit $fail
