#!/usr/bin/env bash
# Install and (re)start the web layer and its proxy (spec 007, 010). Idempotent. Run as root on the host, after the
# supervisor is installed (006-supervisor.sh). Cloudflare is in front in "Full (strict)" mode: Caddy gets a real
# certificate from Let's Encrypt (HTTP-01, which Cloudflare lets through on port 80).
#
#   DOMAIN=zerostress.space bash deploy/010-web.sh
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd)
DOMAIN=${DOMAIN:-zerostress.space}
NODE=/opt/node/bin
CADDY_VERSION=2.11.8
CADDY_SHA512=c863699eee84c6b410573de2ec67af81d07eb054f9020bb98f3c6cb256fea4be2fd1acfbd39110c649c3338282593bba3d3ed6424d91b7f5675e8b877a8999e9
DEST=/opt/zerostress/web
export PATH=$NODE:$PATH

# ---- the web layer: code root-owned and read-only for the service, swapped in as a whole ----
rm -rf "$DEST.new"
install -d -m 0755 -o root -g root "$DEST.new"
for d in agent hooks server; do
  cp -r "$S/web/$d" "$DEST.new/$d"
  rm -rf "$DEST.new/$d/test"
done
install -m 0644 "$S/web/package.json" "$S/web/package-lock.json" "$S/web/tsconfig.json" "$DEST.new/"
(cd "$DEST.new" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
chown -R root:root "$DEST.new"
chmod -R go-w "$DEST.new"
systemctl stop zerostress-web 2>/dev/null || true
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

# country and network of an address: DB-IP Lite tables (CC BY 4.0), refreshed when older than 20 days. A failure here
# is not fatal: the report then names no countries.
install -d -m 0700 -o zerostress-web -g zerostress-web /var/lib/zerostress-web /var/lib/zerostress-web/geo
if node "$S/web/tools/fetch-geo.mjs" /var/lib/zerostress-web/geo; then chown -R zerostress-web:zerostress-web /var/lib/zerostress-web/geo; else echo "geo: tables not updated"; fi

# the data directory is made by systemd (StateDirectory); an earlier version kept it inside the supervisor's own
rmdir /var/lib/zerostress/web/tasks /var/lib/zerostress/web 2>/dev/null || true
# the model is chosen by measurement (spec 008, 8); the key stays as the owner wrote it
if grep -q '^INFERENCE_MODEL=$' /etc/zerostress/web.env; then sed -i 's/^INFERENCE_MODEL=$/INFERENCE_MODEL=qwen3.8-27b/' /etc/zerostress/web.env; fi
install -m 0644 -o root -g root "$S/deploy/systemd/zerostress-web.service" /etc/systemd/system/zerostress-web.service

# ---- Caddy: the official binary, checked against a pinned hash ----
if [[ ! -x /usr/local/bin/caddy ]] || ! /usr/local/bin/caddy version | grep -q "v$CADDY_VERSION"; then
  T=$(mktemp -d)
  curl -fsSL -o "$T/caddy.tgz" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  echo "$CADDY_SHA512  $T/caddy.tgz" | sha512sum -c - >/dev/null || { echo "caddy: the checksum does not match"; exit 1; }
  tar -xzf "$T/caddy.tgz" -C "$T" caddy
  install -m 0755 -o root -g root "$T/caddy" /usr/local/bin/caddy
  rm -rf "$T"
fi
getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -m 0750 -o caddy -g caddy /var/lib/caddy

install -d -m 0755 /etc/caddy

# Only Cloudflare may say who the visitor is: its address ranges are read from Cloudflare itself. The proxy writes
# X-Real-IP from the address it has checked and drops any such header that came from outside.
V4=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 | tr '\n' ' ')
V6=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 | tr '\n' ' ')
[[ -n $V4 && -n $V6 ]] || { echo "could not read Cloudflare's address ranges"; exit 1; }
cat > /etc/caddy/Caddyfile <<C
{
	servers {
		trusted_proxies static $V4 $V6
		client_ip_headers CF-Connecting-IP
	}
}

$DOMAIN {
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Real-IP {client_ip}
		header_up -CF-Connecting-IP
		header_up -X-Forwarded-For
		flush_interval -1
	}
	header -Server
	log {
		output stdout
		format filter {
			wrap json
			# the log keeps no addresses of pages and no cookies
			fields {
				request>uri delete
				request>headers>Cookie delete
				request>headers>X-Task-Key delete
			}
		}
	}
}

C
chmod 0644 /etc/caddy/Caddyfile
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile >/dev/null
install -m 0644 -o root -g root "$S/deploy/systemd/caddy.service" /etc/systemd/system/caddy.service

# ---- the host's own firewall: the web ports ----
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
fi

systemctl daemon-reload
systemctl enable zerostress-web caddy >/dev/null 2>&1
systemctl restart zerostress-web
for _ in $(seq 1 50); do curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS --max-time 5 http://127.0.0.1:8080/healthz; echo
systemctl restart caddy
systemctl --no-pager --lines=0 status zerostress-web caddy | grep -E "Active|●"
