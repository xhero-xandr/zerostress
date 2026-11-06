#!/usr/bin/env bash
# The web layer and its proxy (specs 007, 012): the service code with its production dependencies, the built client,
# the geo tables, the service unit, the Caddyfile and the web ports. Cloudflare is in front in "Full (strict)" mode:
# Caddy gets a real certificate from Let's Encrypt (HTTP-01, which Cloudflare lets through on port 80).
#
#   DOMAIN=zerostress.space deploy/install.sh web
source "$(dirname "$0")/../lib.sh"
need_root
DOMAIN=${DOMAIN:-zerostress.space}
DEST=/opt/zerostress/web

# the client (spec 012): built from its lock file into build/client by the owner of the checkout
as_builder bash -c "cd '$S/web/client' && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npx vite build >/dev/null"
[[ -f $S/build/client/index.html ]] || { echo "client: the build made no index.html" >&2; exit 1; }

# the service: root-owned and read-only for it, swapped in as a whole; the client goes next to it (server/app.ts
# reads ../client/dist)
rm -rf "$DEST.new"
install -d -m 0755 -o root -g root "$DEST.new" "$DEST.new/client"
for d in agent hooks server; do
  cp -r "$S/web/$d" "$DEST.new/$d"
  rm -rf "$DEST.new/$d/test"
done
install -m 0644 "$S/web/package.json" "$S/web/package-lock.json" "$S/web/tsconfig.json" "$DEST.new/"
(cd "$DEST.new" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp -r "$S/build/client" "$DEST.new/client/dist"
chown -R root:root "$DEST.new"
chmod -R go-w "$DEST.new"
systemctl stop zerostress-web 2>/dev/null || true
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

# country and network of an address: DB-IP Lite tables (CC BY 4.0), refreshed when older than 20 days. A failure
# here is not fatal: the report then names no countries.
install -d -m 0700 -o zerostress-web -g zerostress-web /var/lib/zerostress-web /var/lib/zerostress-web/geo
if node "$S/web/tools/fetch-geo.mjs" /var/lib/zerostress-web/geo; then chown -R zerostress-web:zerostress-web /var/lib/zerostress-web/geo; else say "geo: tables not updated"; fi

put 0644 root:root /etc/systemd/system/zerostress-web.service

# Caddy: the Caddyfile from its template; only Cloudflare's own address ranges may say who the visitor is
getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -m 0750 -o caddy -g caddy /var/lib/caddy
V4=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 | tr '\n' ' ')
V6=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 | tr '\n' ' ')
[[ -n $V4 && -n $V6 ]] || { echo "could not read Cloudflare's address ranges" >&2; exit 1; }
install -d -m 0755 /etc/caddy
grep -v '^#tmpl ' "$F/etc/caddy/Caddyfile.tmpl" | sed -e "s|@CLOUDFLARE_RANGES@|$V4 $V6|" -e "s|@DOMAIN@|$DOMAIN|" >/etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "caddy: the Caddyfile does not validate" >&2; exit 1; }
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
