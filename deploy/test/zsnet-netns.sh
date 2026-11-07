#!/usr/bin/env bash
# The real zsnet, tried in throwaway network namespaces (no microVM, the host's own network untouched): a "host"
# namespace runs zsnet and has an external interface; an "inet" namespace stands for the internet; a "guest" namespace
# takes the slot's place through a veth named like the tap. Checks the egress rules by real traffic, and that a table of
# an older ruleset is rebuilt on "up" while keeping the slots of guests that are running.
# Run as root: sudo deploy/test/zsnet-netns.sh
set -euo pipefail
S=$(cd "$(dirname "$0")/../.." && pwd)
ZSNET="bash $S/deploy/helpers/zsnet"
H=zst-host G=zst-guest I=zst-inet
pass=0 fail=0
ok() { echo "  ok    $*"; pass=$((pass + 1)); }
no() { echo "  FAIL  $*"; fail=$((fail + 1)); }
cleanup() { for n in $H $G $I; do ip netns pids "$n" 2>/dev/null | xargs -r kill -9 2>/dev/null || true; ip netns del "$n" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
cleanup
for n in $H $G $I; do ip netns add "$n"; done
inh() { ip netns exec $H "$@"; }
ing() { ip netns exec $G "$@"; }
ini() { ip netns exec $I "$@"; }

# host <-> internet (TEST-NET-2, not in the guest's blocked ranges)
ip link add ext0 netns $H type veth peer name up0 netns $I
inh ip addr add 198.51.100.1/24 dev ext0; inh ip link set ext0 up; inh ip link set lo up
inh ip route add default via 198.51.100.2
ini ip addr add 198.51.100.2/24 dev up0; ini ip link set up0 up; ini ip link set lo up
inh sysctl -qw net.ipv4.ip_forward=1
# zsnet hands its tap to the supervisor's user; the user only has to exist
id zerostress-sup >/dev/null 2>&1 || { echo "zerostress-sup is missing (./zs install host)"; exit 1; }

# an older table (no version, no egress rules) with a guest running on slot 3
inh nft -f - <<'EOF'
table inet zerostress {
  set slots { type ifname . ipv4_addr; elements = { "zstap3" . 172.16.3.2 } }
  chain guest_fwd { counter accept; }
}
EOF

inh $ZSNET up 0
table=$(inh nft list table inet zerostress)
grep -q 'comment "zsnet v' <<<"$table" && ok "an older table was rebuilt with a versioned ruleset" || no "the older table was kept"
grep -q '"zstap3" . 172.16.3.2' <<<"$table" && ok "the running guest's slot survived the rebuild" || no "the running guest's slot was lost"
grep -q '"zstap0" . 172.16.0.2' <<<"$table" && ok "the new slot is in the table" || no "the new slot is missing"

# the guest takes slot 0's place: the tap becomes a veth of the same name
inh ip link del zstap0
ip link add zstap0 netns $H type veth peer name eth0 netns $G
inh ip addr add 172.16.0.1/30 dev zstap0; inh ip link set zstap0 up
ing ip addr add 172.16.0.2/30 dev eth0; ing ip link set eth0 up; ing ip link set lo up
ing ip route add default via 172.16.0.1

# the internet listens on 8080 and on 25 and answers every connection
ini python3 -c '
import socket, threading
def serve(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen(1024)
    while True:
        c, _ = s.accept(); c.close()
for p in (8080, 25): threading.Thread(target=serve, args=(p,), daemon=True).start()
threading.Event().wait()' &
srv=$!
trap 'kill $srv 2>/dev/null || true; cleanup' EXIT INT TERM
sleep 0.5

probe='
import socket, sys
port, n = int(sys.argv[1]), int(sys.argv[2])
good = 0
for _ in range(n):
    s = socket.socket(); s.settimeout(0.3)
    try: s.connect(("198.51.100.2", port)); good += 1
    except OSError: pass
    finally: s.close()
print(good)'
[[ $(ing python3 -c "$probe" 8080 1) == 1 ]] && ok "the guest reaches the internet (control)" || no "the guest cannot reach the internet: the test proves nothing"
[[ $(ing python3 -c "$probe" 25 3) == 0 ]] && ok "port 25 is closed to the guest" || no "the guest reached port 25"
mail() { inh nft list chain inet zerostress guest_fwd | sed -n 's/.*counter packets \([0-9]*\) .*no mail.*/\1/p'; }
seen=$(mail)
inh $ZSNET up 1
[[ ${seen:-0} -gt 0 && $(mail) == "$seen" ]] && ok "a table of the current version is left as it is (its counters go on)" || no "the current table was rebuilt on up (counter $seen -> $(mail))"
inh nft list set inet zerostress slots | grep -q zstap1 && ok "a second slot joins the same table" || no "the second slot is missing"
inh $ZSNET down 1
# 600 connections opened at once (non-blocking), then 1 s to complete: about the burst (200) plus 20/s get through
burst='
import socket, select, time
socks = []
for _ in range(600):
    s = socket.socket(); s.setblocking(False); s.connect_ex(("198.51.100.2", 8080)); socks.append(s)
done, deadline = set(), time.time() + 1.0
while time.time() < deadline:
    _, w, _ = select.select([], [s for s in socks if s not in done], [], 0.1)
    for s in w:
        if s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0: done.add(s)
print(len(done))'
sleep 1.5 # let the bucket refill after the probes above
got=$(ing python3 -c "$burst")
echo "        600 connections at once: $got got through"
(( got >= 150 && got <= 260 )) && ok "a burst of new connections is cut down to the burst and the rate" || no "new connections are not limited as expected ($got of 600)"

echo "zsnet-netns: $pass passed, $fail failed"
(( fail == 0 ))
