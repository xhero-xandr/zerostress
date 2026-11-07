#!/usr/bin/env bash
# Is the host what the repository says it should be? Read-only: changes nothing (spec 010, 6).
#
#   ./zs verify          services, health, KVM, the kernel parameter, versions, SELinux types, the settings files
#                        (names only, values are never printed), every file from deploy/files against the installed one
#   ./zs verify --live   and one real check of https://example.com/ through the public address (starts a microVM
#                        and counts against the limits)
source "$(dirname "$0")/../lib.sh"
need_root
DOMAIN=${DOMAIN:-zerostress.space}
bad=0
ok() { say "ok    $*"; }
no() { say "FAIL  $*"; bad=$((bad + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
type_of() { stat -c %C "$1" 2>/dev/null | cut -d: -f3; }

check "the project is at $ROOT" test "$S" = "$ROOT"
check "/dev/kvm is there" test -e /dev/kvm
check "kernel: spec_store_bypass_disable=seccomp" grep -qw spec_store_bypass_disable=seccomp /proc/cmdline
for s in zerostress-supervisor zerostress-web caddy; do check "$s is active" systemctl is-active --quiet "$s"; done
check "supervisor answers on run/supervisor.sock" curl -fsS --max-time 5 --unix-socket "$S/run/supervisor.sock" http://localhost/v1/health
check "web service answers on 127.0.0.1:8080" curl -fsS --max-time 5 http://127.0.0.1:8080/healthz
check "guest image is installed" test -s "$S/images/guest-rootfs.ext4"
check "node is v$NODE_VERSION" bash -c "'$S/runtime/node/bin/node' --version | grep -qx v$NODE_VERSION"
check "firecracker is $FC_VERSION" bash -c "'$S/bin/firecracker' --version | grep -q $FC_VERSION"
check "caddy is v$CADDY_VERSION" bash -c "'$S/bin/caddy' version | grep -q v$CADDY_VERSION"
check "config/Caddyfile validates" "$S/bin/caddy" validate --config "$S/config/Caddyfile"
for b in zsvm zsnet zerostress-supervisor firecracker caddy; do check "bin/$b is root's and nobody else may change it" bash -c "[[ \$(stat -c '%U %a' '$S/bin/$b') =~ ^root\ 7[0-5][0-5]$ ]]"; done
if command -v getenforce >/dev/null && [[ $(getenforce) == Enforcing ]]; then
  for pair in bin:bin_t runtime/node/bin:bin_t config:etc_t data:var_lib_t run:var_lib_t logs:var_log_t; do
    check "SELinux: ${pair%%:*} is ${pair#*:}" test "$(type_of "$S/${pair%%:*}")" = "${pair#*:}"
  done
fi

for e in web supervisor; do
  if [[ -e $S/config/$e.env ]]; then
    notes=$(env_file "$e" root)
    if [[ -z $notes ]]; then ok "config/$e.env matches its example"; else no "config/$e.env:"; echo "$notes"; fi
  else
    no "config/$e.env is missing"
  fi
done
for f in $(cd "$F" && find . -type f | sort); do
  host=${f#.}
  if cmp -s "$F$host" "$host"; then ok "$host"; else no "$host differs from deploy/files$host"; fi
done
for h in zsvm zsnet; do check "bin/$h is deploy/helpers/$h" cmp -s "$S/bin/$h" "$S/deploy/helpers/$h"; done

if [[ ${1:-} == --live ]]; then
  resp=$(curl -fsS -X POST "https://$DOMAIN/api/tasks" -H 'content-type: application/json' --data '{"url":"https://example.com/"}' || true)
  id=$(sed -n 's/.*"id":"\([0-9a-f]\{32\}\)".*/\1/p' <<<"$resp")
  if [[ -z $id ]]; then
    no "live check: the service did not take it"
  else
    for _ in $(seq 1 120); do
      st=$(curl -fsS "https://$DOMAIN/api/tasks/$id" || true)
      grep -q '"has_report":true\|"stage":"failed"' <<<"$st" && break
      sleep 1
    done
    if grep -q '"has_report":true' <<<"$st"; then ok "live check: a report for https://example.com/"; else no "live check: no report"; fi
  fi
fi

echo
if ((bad)); then echo "verify: $bad problem(s)"; exit 1; fi
echo "verify: all good"
