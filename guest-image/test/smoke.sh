#!/usr/bin/env bash
# Smoke test of the guest image: overlay -> boot with vsock -> agent -> stub collector. Run as root on the host.
# Usage: smoke.sh BASE_IMAGE AGENT_BIN   (defaults: the installed image, guest-image/agent/zerostress-agent)
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-vm.sh"
vm_boot smoke "${1:-}" "${2:-}"

echo "== scenarios"
out=$(run '{"mode":"hello"}');  check "hello + status ok" "$out" '"status":"ok"'
out=$(run '{"mode":"whoami"}'); check "collector runs as pw" "$out" '"out":"pw"'
out=$(run '{"mode":"fetch","url":"https://example.com"}'); check "public internet via guest" "$out" '"status":200'
out=$(run '{"mode":"fetch","url":"http://169.254.169.254/","timeout_ms":3000}'); check "metadata blocked" "$out" '"kind":"error"'
out=$(run '{"mode":"fetch","url":"http://172.16.0.1:22/","timeout_ms":3000}');   check "host gateway blocked" "$out" '"kind":"error"'
out=$(run '{"mode":"chromium"}'); check "chromium (sandbox on) renders and screenshots" "$out" '"kind":"chromium".*"title":"ok"'
host_ms=$(date +%s%3N)
out=$(run '{"mode":"sys"}');    check "no TCP listeners in the guest" "$out" '"tcp_listeners":\[\]'
guest_ms=$(grep -o '"epoch_ms":[0-9]*' <<<"$out" | cut -d: -f2)
skew=$(( guest_ms - host_ms )); skew=${skew#-}
[[ $skew -lt 5000 ]] && echo "PASS  guest clock skew ${skew} ms" || { echo "FAIL  guest clock skew ${skew} ms"; fail=1; }
run '{"mode":"chromium","png":true}' | grep -o '"png_b64":"[^"]*"' | cut -d'"' -f4 | base64 -d > "${SHOT_OUT:-/tmp/smoke-shot.png}" 2>/dev/null
echo "screenshot saved: ${SHOT_OUT:-/tmp/smoke-shot.png} ($(stat -c %s "${SHOT_OUT:-/tmp/smoke-shot.png}") bytes)"
out=$(run '{"mode":"flood"}');  check "oversize capped" "$out" '"status":"oversize"'
size=$(run '{"mode":"flood"}' | wc -c); [[ $size -le 1048900 ]] && echo "PASS  forwarded $size bytes (cap 1048576 + status)" || { echo "FAIL  forwarded $size"; fail=1; }
out=$(run 'garbage');           check "bad job rejected" "$out" '"status":"bad_job"'

# busy: two simultaneous jobs
( run '{"mode":"sleep","ms":3000}' >/dev/null ) &
sleep 0.7
out=$(run '{"mode":"hello"}');  check "second job gets busy" "$out" '"status":"busy"'
wait

echo "== guest listening ports are not observable without a shell; checking secrets in image"
M=$(mktemp -d); mount -o ro,loop,noload "$D/rootfs.ext4" $M
ls $M/etc/ssh/ssh_host_* 2>/dev/null && { echo "FAIL  host keys present"; fail=1; } || echo "PASS  no ssh host keys"
[[ -e $M/root/.ssh/authorized_keys ]] && { echo "FAIL  authorized_keys present"; fail=1; } || echo "PASS  no authorized_keys"
[[ -e $M/usr/bin/socat ]] && { echo "FAIL  socat present"; fail=1; } || echo "PASS  no socat"
umount $M; rmdir $M

if [[ $fail != 0 ]]; then
  echo "== agent log from the guest console"
  grep -aE "client side|job finished|write failed|listening on" "$D/serial.log" | tail -20
fi
[[ $fail == 0 ]] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit $fail
