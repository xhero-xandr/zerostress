#!/usr/bin/env bash
# The one way to install ZeroStress on a host (spec 010). Run as root from a checkout of the repository; builds run as
# the owner of the checkout. Every step is idempotent.
#
#   sudo deploy/install.sh all              a new host: every step below, in order
#   sudo deploy/install.sh web              update the web layer only
#   sudo deploy/install.sh verify [--live]  check the host against the repository, change nothing
#
# Steps:  host  network  runtime  image  supervisor  web  verify
# After `host` on a new machine: fill in /etc/zerostress/web.env (the model key) and reboot if it asks for it.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)

declare -A STEP=([host]=10-host [network]=20-network [runtime]=30-runtime [image]=40-image [supervisor]=50-supervisor [web]=60-web [verify]=90-verify)
ORDER=(host network runtime image supervisor web verify)

usage() { sed -n '2,10s/^# \{0,1\}//p' "$0"; exit "${1:-0}"; }
run() { echo "== $1"; bash "$D/steps/${STEP[$1]}.sh" "${@:2}"; }

[[ $# -ge 1 ]] || usage
case $1 in
  -h | --help | help) usage ;;
  all) for s in "${ORDER[@]}"; do run "$s"; done ;;
  *) [[ -n ${STEP[$1]:-} ]] || { echo "unknown step: $1" >&2; usage 1; }; run "$@" ;;
esac
