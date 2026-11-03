#!/usr/bin/env bash
# Guest network setup per docs/specs/003-guest-network.md. Idempotent. Run as root from the repo's deploy/ dir.
set -euo pipefail
cd "$(dirname "$0")"

install -m 0755 -o root -g root zsnet /opt/zerostress/bin/zsnet
chcon -t bin_t /opt/zerostress/bin/zsnet 2>/dev/null || true

cat >/etc/sysctl.d/90-zerostress.conf <<'EOF'
net.ipv4.ip_forward = 1
EOF
sysctl -q -p /etc/sysctl.d/90-zerostress.conf

# sudoers: supervisor may run exactly these commands
cat >/etc/sudoers.d/zerostress-net <<'EOF'
zerostress-sup ALL=(root) NOPASSWD: /opt/zerostress/bin/zsnet up [0-3], /opt/zerostress/bin/zsnet down [0-3]
EOF
chmod 0440 /etc/sudoers.d/zerostress-net
visudo -cf /etc/sudoers.d/zerostress-net

# firewalld: guests (by source) get their own zone; host input is dropped, forwarding to public is accepted.
# Strict destination filtering lives in the "inet zerostress" table (priority before firewalld).
if ! firewall-cmd --permanent --get-zones | tr ' ' '\n' | grep -qx zerostress; then
  firewall-cmd --permanent --new-zone=zerostress
fi
firewall-cmd --permanent --zone=zerostress --set-target=DROP
firewall-cmd --permanent --zone=zerostress --add-source=172.16.0.0/16 2>/dev/null || true
if ! firewall-cmd --permanent --get-policies | tr ' ' '\n' | grep -qx zerostress-egress; then
  firewall-cmd --permanent --new-policy=zerostress-egress
fi
firewall-cmd --permanent --policy=zerostress-egress --add-ingress-zone=zerostress 2>/dev/null || true
firewall-cmd --permanent --policy=zerostress-egress --add-egress-zone=public 2>/dev/null || true
firewall-cmd --permanent --policy=zerostress-egress --set-target=ACCEPT
firewall-cmd --reload

echo "--- result"
firewall-cmd --zone=zerostress --list-all
firewall-cmd --info-policy=zerostress-egress
sysctl net.ipv4.ip_forward
sudo -l -U zerostress-sup | tail -3
