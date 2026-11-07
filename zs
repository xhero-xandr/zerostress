#!/usr/bin/env bash
# zs: the one command for ZeroStress (spec 010). Everything lives in this directory: /zerostress on the server.
#
#   ./zs install [step...]   set up or update the host; steps: host network runtime image supervisor web verify
#                            (none = all of them, in that order). Needs sudo.
#   ./zs update              git pull, then rebuild and restart the supervisor and the web layer
#   ./zs start|stop|restart|status
#   ./zs logs [web|supervisor|caddy] [-f]    the services' logs in logs/
#   ./zs config [web|supervisor]             edit config/<name>.env, then restart that service
#   ./zs verify [--live]     check the host against the repository; changes nothing
#   ./zs dev                 run the web layer from this checkout on port 8081, with its own data in build/dev
#   ./zs version             this checkout's version (VERSION, and the build: X.Y.Z+N.gHASH after a release) and the
#                            running supervisor's
#   ./zs version set X.Y.Z   write a new version everywhere it is kept, and date its CHANGELOG section
#   ./zs release X.Y.Z       check CHANGELOG.md and the versions, then tag vX.Y.Z on main (push the tag yourself)
#
# A new server: git clone https://github.com/xhero-xandr/zerostress /zerostress && cd /zerostress && sudo ./zs install host
# then put the model key in with `./zs config web`, reboot if it asked to, and `sudo ./zs install && ./zs verify --live`.
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
SERVICES=(zerostress-supervisor zerostress-web caddy)
declare -A STEP=([host]=10-host [network]=20-network [runtime]=30-runtime [image]=40-image [supervisor]=50-supervisor [web]=60-web [verify]=90-verify)
ORDER=(host network runtime image supervisor web verify)

usage() { sed -n '2,16s/^# \{0,1\}//p' "$0"; exit "${1:-0}"; }
sudo_self() { if [[ $EUID -ne 0 ]]; then exec sudo "$0" "$@"; fi; }
step() { echo "== $1"; bash "$S/deploy/steps/${STEP[$1]}.sh" "${@:2}"; }

cmd=${1:-help}
shift || true
case $cmd in
  help | -h | --help) usage ;;
  release) exec bash "$S/deploy/release.sh" tag "$@" ;;
  version)
    if [[ ${1:-} == set ]]; then shift; exec bash "$S/deploy/release.sh" set "$@"; fi
    echo "release:    $(tr -d '[:space:]' < "$S/VERSION")"
    echo "this build: $(bash "$S/deploy/release.sh" describe)"
    echo "supervisor: $(curl -fsS --max-time 5 --unix-socket "$S/run/supervisor.sock" http://localhost/v1/health 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' || true)"
    ;;
  install)
    sudo_self install "$@"
    if [[ $# -eq 0 ]]; then set -- "${ORDER[@]}"; fi
    for s in "$@"; do [[ -n ${STEP[$s]:-} ]] || { echo "unknown step: $s" >&2; usage 1; }; done
    for s in "$@"; do step "$s"; done
    ;;
  update)
    sudo_self update "$@"
    # shellcheck source=deploy/lib.sh
    (source "$S/deploy/lib.sh" && own_code)
    owner=$(stat -c %U "$S")
    runuser -u "$owner" -- git -C "$S" pull --ff-only
    step supervisor
    step web
    step verify
    echo "the guest image and the runtime are not rebuilt by update: ./zs install image | runtime when they changed"
    ;;
  start | stop | restart)
    sudo_self "$cmd"
    systemctl "$cmd" "${SERVICES[@]}"
    systemctl --no-pager --lines=0 status "${SERVICES[@]}" | grep -E '^●|Active:' || true
    ;;
  status)
    systemctl --no-pager --lines=0 status "${SERVICES[@]}" | grep -E '^●|Active:' || true
    for n in web supervisor caddy; do [[ -f $S/logs/$n.log ]] && printf '  logs/%s.log: %s\n' "$n" "$(du -h "$S/logs/$n.log" | cut -f1)"; done
    ;;
  logs)
    name=${1:-}; follow=""
    [[ $name == -f ]] && { name=""; follow=-f; }
    [[ ${2:-} == -f ]] && follow=-f
    if [[ -n $name ]]; then files=("$S/logs/$name.log"); else files=("$S"/logs/*.log); fi
    tail -n 100 $follow "${files[@]}"
    ;;
  config)
    name=${1:-web}
    [[ $name == web || $name == supervisor ]] || { echo "config: web or supervisor" >&2; exit 1; }
    [[ -e $S/config/$name.env ]] || { echo "no config/$name.env yet: sudo ./zs install host makes it from config/$name.env.example" >&2; exit 1; }
    sudoedit "$S/config/$name.env"
    sudo systemctl restart "zerostress-$name"
    echo "zerostress-$name restarted"
    ;;
  verify)
    sudo_self verify "$@"
    step verify "$@"
    ;;
  dev)
    # the service as on the server, but on its own port and with its own data, so it never touches the real one
    [[ -f $S/build/client/index.html ]] || (cd "$S/web/client" && npx vite build >/dev/null)
    mkdir -p "$S/build/dev/tasks"
    envfile=()
    [[ -r $S/config/web.env ]] && envfile=(--env-file="$S/config/web.env")
    node=$S/runtime/node/bin/node
    [[ -x $node ]] || node=$(command -v node) || { echo "no node: ./zs install runtime, or Node $(. "$S/deploy/versions.env"; echo "$NODE_VERSION") on PATH" >&2; exit 1; }
    cd "$S/web"
    WEB_PORT=${WEB_PORT:-8081} WEB_DATA_DIR=${WEB_DATA_DIR:-$S/build/dev/tasks} \
      exec "$node" "${envfile[@]}" --disable-warning=ExperimentalWarning --watch server/main.ts
    ;;
  *) echo "unknown command: $cmd" >&2; usage 1 ;;
esac
