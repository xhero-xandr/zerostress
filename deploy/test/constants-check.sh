#!/usr/bin/env bash
# Values that several parts of the project repeat must agree, and nothing else checks that: the number of slots (Go,
# zsvm, zsnet, sudoers, users, verify), the vsock port (supervisor, guest agent, the unit in the image), the longest
# session (supervisor, guest agent, collector), the size of an artifact, how many commands a session may carry, and
# which deadline is longer than which (review F). Needs no KVM and no root: it only reads files. Every check is tried
# against a copy with one value changed, and must fail there: a check that cannot fail proves nothing.
#
#   bash deploy/test/constants-check.sh            check this checkout
#   bash deploy/test/constants-check.sh --controls  change one value at a time in a copy: every change must be caught
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ${1:-} == --controls ]]; then
  # file | sed expression | what the change stands for. The copy lives in a fixed directory that every run overwrites.
  SRC=$(cd "$HERE/../.." && pwd)
  COPY=${TMPDIR:-/tmp}/zs-constants-controls
  CONTROLS=(
    'deploy/files/etc/sudoers.d/zerostress-vm|s/zsvm run \[0-3\]/zsvm run [0-2]/|sudoers lets one slot less run a VM'
    'deploy/files/etc/sudoers.d/zerostress-net|s/zsnet up \[0-3\]/zsnet up [0-4]/|sudoers lets one slot more bring the network up'
    'deploy/helpers/zsvm|s/\^\[0-3\]\$/^[0-4]$/|zsvm accepts one slot more'
    'deploy/helpers/zsnet|s/^MAX_SLOT=3/MAX_SLOT=4/|zsnet has one more slot'
    'deploy/steps/10-host.sh|s/^for n in 0 1 2 3; do/for n in 0 1 2; do/|one user of Firecracker too few'
    'deploy/steps/90-verify.sh|s/^for n in 0 1 2 3; do/for n in 0 1 2; do/|verify looks at one user too few'
    'supervisor/config.go|s/get("SUP_CONCURRENCY", 2, 1, 4)/get("SUP_CONCURRENCY", 2, 1, 5)/|the supervisor allows one more run than there are slots'
    'guest/agent/main.go|s/flag.Uint("port", 5000,/flag.Uint("port", 5001,/|the guest agent listens on another port'
    'guest/image/overlay/zerostress-agent.service|s/ -port 5000 / -port 5002 /|the image starts the agent on another port'
    'guest/collector/lib/limits.mjs|s/sessionMaxCapS: 600,/sessionMaxCapS: 601,/|the collector caps a session at another length'
    'guest/agent/agent.go|s/cfg.SessionMax = 600 \* time.Second/cfg.SessionMax = 300 * time.Second/|the guest agent caps a session at another length'
    'guest/agent/agent.go|s/cfg.SessionGrace = 30 \* time.Second/cfg.SessionGrace = 31 * time.Second/|the guest agent waits another grace'
    'guest/agent/artifact.go|s/defaultMaxArtifact = 32 << 20/defaultMaxArtifact = 16 << 20/|the guest agent hands over smaller artifacts'
    'guest/agent/agent.go|s/cfg.MaxCmds = 200$/cfg.MaxCmds = 100/|the guest takes fewer commands than the supervisor lets through'
    'supervisor/config.go|s/get("SUP_HARD_TIMEOUT_S", 90, 5, 600)/get("SUP_HARD_TIMEOUT_S", 70, 5, 600)/|the hard limit is shorter than boot plus the collector'
    'guest/image/overlay/zerostress-agent.service|s/ -timeout 60s / -timeout 80s /|the collector gets longer than the hard limit allows'
  )
  bad=0
  for c in "${CONTROLS[@]}"; do
    file=${c%%|*}; rest=${c#*|}; expr=${rest%%|*}; what=${rest#*|}
    mkdir -p "$COPY"
    for d in deploy/helpers deploy/files deploy/steps supervisor/config.go guest/agent guest/collector/lib/limits.mjs guest/image/overlay; do
      mkdir -p "$COPY/$(dirname "$d")"; cp -a "$SRC/$d" "$COPY/$(dirname "$d")/"
    done
    sed -i "$expr" "$COPY/$file"
    if cmp -s "$SRC/$file" "$COPY/$file"; then echo "NOT APPLIED: $what"; bad=1; continue; fi
    if ZS_ROOT=$COPY bash "$HERE/constants-check.sh" >/dev/null 2>&1; then echo "SURVIVED:    $what"; bad=1; else echo "caught:      $what"; fi
  done
  ((bad)) && { echo "constants-check controls: SOMETHING SURVIVED OR DID NOT APPLY"; exit 1; }
  echo "constants-check controls: every change is caught"
  exit 0
fi
ROOT=${ZS_ROOT:-$(cd "$HERE/../.." && pwd)}
fail=0
ok() { echo "ok    $1"; }
no() { echo "FAIL  $1${2:+: $2}"; fail=1; }
same() { # what, then the values, all of which must be equal and numbers
  local what=$1; shift
  local first=$1 v
  [[ $first =~ ^[0-9]+$ ]] || { no "$what" "no number found (got '$first'): the file changed shape, so does this check"; return; }
  for v in "$@"; do [[ $v == "$first" ]] || { no "$what" "values differ: $*"; return; }; done
  ok "$what: $first"
}
f() { echo "$ROOT/$1"; }
# first number captured by a sed expression from a file
num() { sed -n "$2" "$(f "$1")" | head -1; }

# ---- slots: 0..N-1 -------------------------------------------------------------------------------------------------
# a range [0-K] gives K+1; a list "0 1 2 3" gives its length
range_count() { local k; k=$(grep -oE '\[0-([0-9])\]' | head -1 | sed 's/\[0-\([0-9]\)\]/\1/'); [[ -n $k ]] && echo $((k + 1)); }
slots_zsvm=$(grep -E 'slot =~' "$(f deploy/helpers/zsvm)" | range_count)
slots_zsnet=$(grep -E 'n =~' "$(f deploy/helpers/zsnet)" | range_count)
max_slot=$(num deploy/helpers/zsnet 's/^MAX_SLOT=\([0-9]*\).*/\1/p')
slots_maxvar=$([[ $max_slot =~ ^[0-9]+$ ]] && echo $((max_slot + 1)))
slots_sudo_vm=$(grep -E 'zsvm run' "$(f deploy/files/etc/sudoers.d/zerostress-vm)" | grep -oE 'zsvm run \[0-[0-9]\]' | range_count)
slots_sudo_up=$(grep -oE 'zsnet up \[0-[0-9]\]' "$(f deploy/files/etc/sudoers.d/zerostress-net)" | range_count)
slots_sudo_down=$(grep -oE 'zsnet down \[0-[0-9]\]' "$(f deploy/files/etc/sudoers.d/zerostress-net)" | range_count)
slots_nft=$(grep -oE 'zstap\[0-[0-9]\]' "$(f deploy/helpers/zsnet)" | head -1 | sed 's/zstap//' | range_count)
slots_users=$(grep -E '^for n in [0-9 ]+; do' "$(f deploy/steps/10-host.sh)" | head -1 | sed 's/^for n in \(.*\); do/\1/' | wc -w)
slots_groups=$(grep -oE 'usermod -aG zerostress-vm0[^ ]*' "$(f deploy/steps/10-host.sh)" | head -1 | tr ',' '\n' | wc -l)
slots_verify=$(grep -E '^for n in [0-9 ]+; do' "$(f deploy/steps/90-verify.sh)" | head -1 | sed 's/^for n in \(.*\); do/\1/' | wc -w)
cap_conc=$(num supervisor/config.go 's/.*get("SUP_CONCURRENCY", *[0-9]*, *[0-9]*, *\([0-9]*\)).*/\1/p')
cap_sess=$(num supervisor/config.go 's/.*get("SUP_SESSION_SLOTS", *[0-9]*, *[0-9]*, *\([0-9]*\)).*/\1/p')
same "the number of slots: zsvm, zsnet, its MAX_SLOT and nft set, sudoers, users, groups, verify, and the supervisor's largest concurrency and session slots" \
  "$slots_zsvm" "$slots_zsnet" "$slots_maxvar" "$slots_nft" "$slots_sudo_vm" "$slots_sudo_up" "$slots_sudo_down" "$slots_users" "$slots_groups" "$slots_verify" "$cap_conc" "$cap_sess"

# ---- the vsock port --------------------------------------------------------------------------------------------------
same "the vsock port: supervisor, guest agent default, the unit in the image" \
  "$(num supervisor/config.go 's/.*VsockPort: *\([0-9]*\),.*/\1/p')" \
  "$(num guest/agent/main.go 's/.*flag.Uint("port", \([0-9]*\),.*/\1/p')" \
  "$(num guest/image/overlay/zerostress-agent.service 's/.*zerostress-agent .*-port \([0-9]*\) .*/\1/p')"

# ---- the longest session, in seconds ------------------------------------------------------------------------------------
same "the longest session: supervisor's SUP_SESSION_MAX_S ceiling, guest agent flag and default, collector cap" \
  "$(num supervisor/config.go 's/.*get("SUP_SESSION_MAX_S", *[0-9]*, *[0-9]*, *\([0-9]*\)).*/\1/p')" \
  "$(num guest/agent/main.go 's/.*"session-max", \([0-9]*\)\*time.Second.*/\1/p')" \
  "$(num guest/agent/agent.go 's/.*cfg.SessionMax = \([0-9]*\) \* time.Second.*/\1/p')" \
  "$(num guest/collector/lib/limits.mjs 's/.*sessionMaxCapS: *\([0-9]*\),.*/\1/p')"

# ---- the grace after a session, in seconds ---------------------------------------------------------------------------------
same "the grace after a session: supervisor default, guest agent flag and default" \
  "$(num supervisor/config.go 's/.*get("SUP_SESSION_GRACE_S", *\([0-9]*\),.*/\1/p')" \
  "$(num guest/agent/main.go 's/.*"session-grace", \([0-9]*\)\*time.Second.*/\1/p')" \
  "$(num guest/agent/agent.go 's/.*cfg.SessionGrace = \([0-9]*\) \* time.Second.*/\1/p')"

# ---- the size of an artifact, in MiB -----------------------------------------------------------------------------------------
same "the size of an artifact: what the supervisor takes in all, what the guest agent hands over for one" \
  "$(num supervisor/config.go 's/.*MaxArtifactBytes: *\([0-9]*\) << 20.*/\1/p')" \
  "$(num guest/agent/artifact.go 's/.*defaultMaxArtifact = \([0-9]*\) << 20.*/\1/p')"

# ---- commands per session: the guest must take every one the supervisor lets through, and the close ------------------------------
sup_cmd=$(num supervisor/config.go 's/.*get("SUP_COMMAND_MAX", *[0-9]*, *[0-9]*, *\([0-9]*\)).*/\1/p')
guest_cmds=$(num guest/agent/agent.go 's/.*cfg.MaxCmds = \([0-9]*\)$/\1/p')
if [[ $sup_cmd =~ ^[0-9]+$ && $guest_cmds =~ ^[0-9]+$ ]]; then
  if ((guest_cmds >= sup_cmd + 1)); then ok "commands per session: the guest takes $guest_cmds, the supervisor lets at most $sup_cmd through, plus the close"; else no "commands per session" "the guest takes $guest_cmds but the supervisor lets $sup_cmd through, and the close is one more"; fi
else no "commands per session" "no number found (supervisor '$sup_cmd', guest '$guest_cmds')"; fi

# ---- deadlines: boot, then the collector's own limit, all inside the supervisor's hard limit ------------------------------------------
boot=$(num supervisor/config.go 's/.*get("SUP_BOOT_TIMEOUT_S", *\([0-9]*\),.*/\1/p')
hard=$(num supervisor/config.go 's/.*get("SUP_HARD_TIMEOUT_S", *\([0-9]*\),.*/\1/p')
coll=$(num guest/image/overlay/zerostress-agent.service 's/.*-timeout \([0-9]*\)s .*/\1/p')
if [[ $boot =~ ^[0-9]+$ && $hard =~ ^[0-9]+$ && $coll =~ ^[0-9]+$ ]]; then
  if ((boot + coll < hard)); then ok "deadlines: boot $boot s + the collector's $coll s < the supervisor's hard limit $hard s"; else no "deadlines" "boot $boot + collector $coll is not under the hard limit $hard"; fi
else no "deadlines" "no number found (boot '$boot', hard '$hard', collector '$coll')"; fi

((fail)) && { echo "constants-check: FAILED"; exit 1; }
echo "constants-check: all agree"
