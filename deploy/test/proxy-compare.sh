#!/usr/bin/env bash
# Caddy (EPEL) vs HAProxy (AppStream) on this host under SELinux Enforcing, both started by their own systemd units:
# SSE streaming, a 45 s silent SSE stream, per-IP request rate limit, per-IP concurrent connection limit, SELinux denials.
# Temporarily replaces /etc/caddy/Caddyfile and /etc/haproxy/haproxy.cfg and restores them. Run as root.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=/opt/node/bin/node
T0=$(date +%s)

backend_pid=
cleanup() {
  systemctl stop caddy haproxy 2>/dev/null
  [[ -n $backend_pid ]] && kill "$backend_pid" 2>/dev/null
  [[ -f /etc/caddy/Caddyfile.orig ]] && mv -f /etc/caddy/Caddyfile.orig /etc/caddy/Caddyfile
  [[ -f /etc/haproxy/haproxy.cfg.orig ]] && mv -f /etc/haproxy/haproxy.cfg.orig /etc/haproxy/haproxy.cfg
}
trap cleanup EXIT

# Ports matter under SELinux: the proxies may only bind and connect to ports labelled for them. 8008, 9000 and 81 are
# http_port_t (what 80 and 443 are in production); an arbitrary port like 8081 is refused (name_bind), which this
# script's first version found out.
BACKEND=8009
PORT=$BACKEND $NODE "$HERE/sse-backend.mjs" & backend_pid=$!
sleep 1
echo "backend: $(curl -s --max-time 3 http://127.0.0.1:$BACKEND/ping | head -1)"

cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
cat > /etc/caddy/Caddyfile <<'EOF'
{
	admin off
	auto_https off
}
http://127.0.0.1:8008 {
	reverse_proxy 127.0.0.1:8009
}
EOF
cp /etc/haproxy/haproxy.cfg /etc/haproxy/haproxy.cfg.orig
cat > /etc/haproxy/haproxy.cfg <<'EOF'
global
	maxconn 500
defaults
	mode http
	timeout connect 5s
	timeout client 30s
	timeout server 30s
# plain proxy with per-IP request rate limit
frontend rate
	bind 127.0.0.1:9000
	stick-table type ip size 100k expire 30s store http_req_rate(10s)
	http-request track-sc0 src
	http-request deny deny_status 429 if { sc_http_req_rate(0) gt 20 }
	default_backend be
# per-IP concurrent connection limit (for long SSE streams)
frontend conns
	bind 127.0.0.1:81
	stick-table type ip size 100k expire 30s store conn_cur
	tcp-request connection track-sc0 src
	tcp-request connection reject if { sc_conn_cur(0) gt 3 }
	default_backend be
backend be
	server s1 127.0.0.1:8009
EOF

echo "== start both with their own units"
systemctl start caddy 2>&1 | tail -2;   echo "caddy:   $(systemctl is-active caddy)"
systemctl start haproxy 2>&1 | tail -2; echo "haproxy: $(systemctl is-active haproxy)"
sleep 1
echo "caddy   -> backend: $(curl -s --max-time 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:8008/ping)"
echo "haproxy -> backend: $(curl -s --max-time 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/ping)"

echo "== SSE: an event every 2 s through each proxy (events must arrive at once, not in a batch)"
# wait for the clients by PID: a bare "wait" would also wait for the backend, which never exits
$NODE "$HERE/sse-client.mjs" http://127.0.0.1:8008/events caddy & p1=$!
$NODE "$HERE/sse-client.mjs" http://127.0.0.1:9000/events haproxy-30s-timeouts & p2=$!
wait $p1 $p2

echo "== SSE: 45 s of silence (HAProxy timeouts here are 30 s)"
$NODE "$HERE/sse-client.mjs" http://127.0.0.1:8008/idle caddy & p1=$!
$NODE "$HERE/sse-client.mjs" http://127.0.0.1:9000/idle haproxy-30s-timeouts & p2=$!
wait $p1 $p2

echo "== HAProxy per-IP request rate limit (more than 20 requests in 10 s must get 429)"
codes=$(for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:9000/ping; done)
echo "30 quick requests: $(tr ' ' '\n' <<<"$codes" | sort | uniq -c | tr '\n' ' ')"

echo "== HAProxy per-IP concurrent connections limit (5 parallel SSE streams, limit 3)"
pids=()
for i in 1 2 3 4 5; do
  $NODE "$HERE/sse-client.mjs" http://127.0.0.1:81/events "stream$i" & pids+=($!)
  sleep 0.3
done
wait "${pids[@]}"

echo "== SELinux denials since the start (read from the audit logs directly)"
avc=$(cat /var/log/audit/audit.log.1 /var/log/audit/audit.log 2>/dev/null | grep -E 'type=AVC' | awk -v t0="$T0" 'match($0, /audit\(([0-9]+)/, m) && m[1] >= t0')
if [[ -z $avc ]]; then echo "(none)"; else echo "$avc" | sed -E 's/.*denied *\{ ([^}]*) \}.*comm="?([^" ]*)"?.*scontext=([^ ]*) tcontext=([^ ]*) tclass=([^ ]*).*/\2: denied { \1 } \3 -> \4 (\5)/' | sort | uniq -c; fi
echo "processes: caddy runs as $(ps -o label= -C caddy 2>/dev/null | head -1), haproxy as $(ps -o label= -C haproxy 2>/dev/null | head -1)"
