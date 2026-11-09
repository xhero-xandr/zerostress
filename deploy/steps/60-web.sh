#!/usr/bin/env bash
# The web layer and its proxy (specs 007, 012). The service runs straight from the checkout (web/, read-only for it)
# and serves build/client. Cloudflare is in front in "Full (strict)" mode: Caddy gets a real certificate from Let's
# Encrypt (HTTP-01, which Cloudflare lets through on port 80).
#
#   DOMAIN=zerostress.space ./zs install web
source "$(dirname "$0")/../lib.sh"
need_root
need_root_dir
DOMAIN=${DOMAIN:-zerostress.space}

# the code's dependencies and the client, from their lock files, by the owner of the checkout
own_code
as_builder bash -c "cd '$S/web' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null"
as_builder bash -c "cd '$S/web/client' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npx vite build >/dev/null"
[[ -f $S/build/client/index.html ]] || { echo "client: the build made no index.html" >&2; exit 1; }

# The browser check of the whole thing: the collector's Playwright (pinned by its lock file), its Chromium (the owner's
# home, not the system's), and the extension build that web/tools/panel-check.mjs loads. Nothing here runs in the service.
as_builder bash -c "cd '$S/guest/collector' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npx playwright install chromium >/dev/null"
as_builder bash -c "cd '$S/web/client' && npm run build:extension >/dev/null"
[[ -f $S/build/extension/manifest.json ]] || { echo "extension: the build made no manifest.json" >&2; exit 1; }

# country and network of an address: DB-IP Lite tables (CC BY 4.0), refreshed when older than 20 days. A failure
# here is not fatal: the report then names no countries.
if node "$S/web/tools/fetch-geo.mjs" "$S/data/geo"; then chown -R zerostress-web:zerostress-web "$S/data/geo"; else say "geo: tables not updated"; fi

# Caddy's configuration from its template: only Cloudflare's own address ranges may say who the visitor is
V4=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 | tr '\n' ' ')
V6=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 | tr '\n' ' ')
[[ -n $V4 && -n $V6 ]] || { echo "could not read Cloudflare's address ranges" >&2; exit 1; }
grep -v '^#tmpl ' "$S/deploy/templates/Caddyfile.tmpl" | sed -e "s|@CLOUDFLARE_RANGES@|$V4 $V6|" -e "s|@DOMAIN@|$DOMAIN|" >"$S/config/Caddyfile"
chmod 0644 "$S/config/Caddyfile"
restorecon "$S/config/Caddyfile" 2>/dev/null || true
"$S/bin/caddy" validate --config "$S/config/Caddyfile" >/dev/null 2>&1 || { echo "caddy: config/Caddyfile does not validate" >&2; exit 1; }

put 0644 root:root /etc/systemd/system/zerostress-web.service
put 0644 root:root /etc/systemd/system/caddy.service
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
fi

systemctl daemon-reload
systemctl enable zerostress-web caddy >/dev/null 2>&1
systemctl restart zerostress-web
for _ in $(seq 1 50); do curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 0.2; done
say "healthz: $(curl -fsS --max-time 5 http://127.0.0.1:8080/healthz)"
systemctl restart caddy
