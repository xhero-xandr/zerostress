#!/usr/bin/env bash
# Session mode of the guest agent (v2) on a real microVM over real vsock: command forwarding, pipelining, bad
# commands, a vanishing client, and the browser inside the guest (aria snapshot, refs, memory). Run as root on the host.
# Usage: session.sh BASE_IMAGE AGENT_BIN   (defaults: the installed image, guest-image/agent/zerostress-agent)
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-vm.sh"
vm_boot session "${1:-}" "${2:-}"

SESS='{"mode":"session","session":{"idle_s":60,"max_s":120}}'
ids() { grep '"kind":"command"' <<<"$1" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' '; }

echo "== commands reach the collector in order"
out=$(run "$SESS" '{"cmd":"wait","id":"a","ms":10}' '{"cmd":"scroll","id":"b","dy":300}' '{"cmd":"close","id":"c"}')
check "ids in order" "$(ids "$out")" '^a b c $'
check "command bytes unchanged" "$out" '"raw":"\{\\"cmd\\":\\"scroll\\",\\"id\\":\\"b\\",\\"dy\\":300\}"'
check "status ok, three commands" "$out" '"status":"ok".*"commands":3'

echo "== pipelined: job and commands in one write"
out=$(run "$SESS" '{"cmd":"wait","id":"p1","ms":1}' '{"cmd":"wait","id":"p2","ms":1}' '{"cmd":"close","id":"p3"}' --burst)
check "none lost" "$(ids "$out")" '^p1 p2 p3 $'

echo "== bad commands end the job, the agent is free afterwards"
for c in 'not json' '[1,2]' '{"cmd":'; do
  out=$(run "$SESS" "$c")
  check "bad_command for: $c" "$out" '"status":"bad_command"'
done
big=$(printf '{"a":"%s"}' "$(head -c 5000 /dev/zero | tr '\0' x)")
out=$(run "$SESS" "$big")
check "bad_command for a 5000-byte line (status survives)" "$out" '"status":"bad_command"'
out=$(run '{"mode":"hello"}'); check "agent free after bad commands" "$out" '"status":"ok"'

echo "== a client that vanishes mid-session"
run "$SESS" '{"cmd":"wait","id":"x","ms":1}' --abort-ms=300 >/dev/null
sleep 1
out=$(run '{"mode":"hello"}'); check "agent free after the client left" "$out" '"status":"ok"'

echo "== session does not leak into plain jobs"
out=$(run '{"mode":"hello"}' '{"cmd":"scroll","id":"z"}')
check "plain job ignores commands, no command events" "$(ids "$out")" '^$'

echo "== browser in the guest"
out=$(run "$SESS" '{"cmd":"snapshot","id":"s1"}' '{"cmd":"close","id":"s2"}')
check "snapshot event present" "$out" '"kind":"snapshot"'
check "aria snapshot has refs" "$out" '\[ref=e[0-9]+\]'
check "ref resolves through aria-ref= to the link href" "$out" '"href":"https://example.com/x"'
check "hidden text is not in the snapshot" "$(grep -c 'hidden text' <<<"$out")" '^0$'
check "session ended ok" "$out" '"status":"ok"'
snap=$(grep '"kind":"snapshot"' <<<"$out")
echo "memory: before=$(grep -o '"mem_used_before_mib":[0-9]*' <<<"$snap") after=$(grep -o '"mem_used_after_mib":[0-9]*' <<<"$snap") browser=$(grep -o '"browser_pss_mib":[0-9]*' <<<"$snap")"
echo "snapshot text:"; grep -o '"text":"[^"]*"' <<<"$snap" | head -1 | sed 's/\\n/\n/g' | cut -c1-200

if [[ $fail != 0 ]]; then
  echo "== agent log from the guest console"
  grep -aE "job finished|client side|write failed|listening on|command" "$D/serial.log" | tail -30
fi
[[ $fail == 0 ]] && echo "SESSION OK" || echo "SESSION FAILED"
exit $fail
