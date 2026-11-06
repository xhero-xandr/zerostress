#!/usr/bin/env bash
# Is the host what the repository says it should be? Read-only: changes nothing on the host (spec 010, 6).
#
#   deploy/install.sh verify            services, health, KVM, the kernel parameter, the environment files, and every
#                                       file from deploy/files compared with the one installed
#   deploy/install.sh verify --live     and one real check of https://example.com/ through the public address (it
#                                       starts a microVM and counts against the limits)
source "$(dirname "$0")/../lib.sh"
need_root
DOMAIN=${DOMAIN:-zerostress.space}
bad=0
ok() { say "ok    $*"; }
no() { say "FAIL  $*"; bad=$((bad + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }

check "/dev/kvm is there" test -e /dev/kvm
check "kernel: spec_store_bypass_disable=seccomp" grep -qw spec_store_bypass_disable=seccomp /proc/cmdline
for s in zerostress-supervisor zerostress-web caddy; do check "$s is active" systemctl is-active --quiet "$s"; done
check "supervisor answers on its socket" curl -fsS --max-time 5 --unix-socket /run/zerostress/supervisor.sock http://localhost/v1/health
check "web service answers on 127.0.0.1:8080" curl -fsS --max-time 5 http://127.0.0.1:8080/healthz
check "guest image is installed" test -s /opt/zerostress/images/guest-rootfs.ext4
check "node is v$NODE_VERSION" bash -c "/opt/node/bin/node --version | grep -qx v$NODE_VERSION"
check "firecracker is $FC_VERSION" bash -c "/opt/zerostress/bin/firecracker --version | grep -q $FC_VERSION"
check "caddy is v$CADDY_VERSION" bash -c "/usr/local/bin/caddy version | grep -q v$CADDY_VERSION"

# the environment files: names only, values are never printed
for e in web supervisor; do
  if [[ -e /etc/zerostress/$e.env ]]; then
    notes=$(env_file "$e" root)
    if [[ -z $notes ]]; then ok "/etc/zerostress/$e.env matches its example"; else no "/etc/zerostress/$e.env:"; echo "$notes"; fi
  else
    no "/etc/zerostress/$e.env is missing"
  fi
done

# every file the repository puts on the host is the one installed (the Caddyfile is made from a template, so it is
# checked by `caddy validate` instead)
while IFS= read -r f; do
  host=${f#"$F"}
  case $host in */Caddyfile.tmpl | /etc/zerostress/*.env.example) continue ;; esac
  if cmp -s "$f" "$host"; then ok "$host"; else no "$host differs from deploy/files$host"; fi
done < <(find "$F" -type f | sort)
check "/etc/caddy/Caddyfile validates" /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile

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
