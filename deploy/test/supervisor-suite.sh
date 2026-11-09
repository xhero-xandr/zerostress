#!/usr/bin/env bash
# The three supervisor end-to-end tests (supervisor-e2e, supervisor-sessions-e2e, supervisor-timeouts) as one run. They
# need what the live service is not: the test collector in the image (deploy/test/stub-collector.mjs) and two slots for
# plain runs, one for sessions. This lays the stub over a copy of the installed image, sets SUP_CONCURRENCY=2 and
# SUP_SESSION_SLOTS=1 through a systemd drop-in, restarts the supervisor, runs the three, and ALWAYS puts the installed
# image, the settings and the service back. While it runs a real visitor would get test answers: run it when nobody
# is using the site. Run as root on the host, from the working copy to test, with the supervisor service running.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
source "$HERE/lib-e2e.sh"
DROPIN_DIR=/etc/systemd/system/zerostress-supervisor.service.d
DROPIN=$DROPIN_DIR/suite-test.conf
SUITE_ENV=/run/zerostress-suite-test.env   # EnvironmentFile= beats Environment=, so the later file is what wins over config/supervisor.env

[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
[[ -e $BACKUP ]] && { echo "$BACKUP exists: an earlier run was interrupted. Put it back first (mv -f $BACKUP $IMG) after checking which image is the real one."; exit 1; }
[[ $(pgrep -c firecracker) == 0 ]] || { echo "a microVM is running; wait until the service is idle"; exit 1; }
[[ -x $SRC/build/guest-agent/zerostress-agent ]] || { echo "build the agent first (guest/agent/build.sh)"; exit 1; }

restore() {
  rm -f "$DROPIN" "$SUITE_ENV"; rmdir "$DROPIN_DIR" 2>/dev/null
  restore_image
  systemctl daemon-reload; systemctl restart zerostress-supervisor
  echo "settings, image and service put back"
}
trap restore EXIT

lay_collector "$SRC/deploy/test/stub-collector.mjs"
mkdir -p "$DROPIN_DIR"
printf 'SUP_CONCURRENCY=2\nSUP_SESSION_SLOTS=1\n' > "$SUITE_ENV"
printf '[Service]\nEnvironmentFile=%s\n' "$SUITE_ENV" > "$DROPIN"
systemctl daemon-reload; systemctl restart zerostress-supervisor
for _ in $(seq 1 40); do api -m 2 http://localhost/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "supervisor now: $(api http://localhost/v1/health | grep -o '"concurrency":[0-9]*\|"limit":[0-9]*' | tr '\n' ' ')"

status=0
for t in supervisor-e2e supervisor-sessions-e2e supervisor-timeouts; do
  echo "############ $t"
  bash "$HERE/$t.sh" || status=1
done
echo
((status)) && echo "SUPERVISOR SUITE: SOMETHING FAILED" || echo "SUPERVISOR SUITE: all passed"
exit $status
