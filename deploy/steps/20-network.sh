#!/usr/bin/env bash
# The guests' network (spec 003): the slot helper, forwarding, its sudoers rule, the firewalld zone and policy.
# Idempotent. Strict destination filtering lives in zsnet's "inet zerostress" table, ahead of firewalld.
source "$(dirname "$0")/../lib.sh"
need_root

put 0755 root:root /opt/zerostress/bin/zsnet
chcon -t bin_t /opt/zerostress/bin/zsnet 2>/dev/null || true

put 0644 root:root /etc/sysctl.d/90-zerostress.conf
sysctl -q -p /etc/sysctl.d/90-zerostress.conf

# the supervisor may run exactly these commands
put 0440 root:root /etc/sudoers.d/zerostress-net
visudo -cqf /etc/sudoers.d/zerostress-net

# guests (by source) get their own zone: input to the host is dropped, forwarding to the public zone is accepted
if ! firewall-cmd --permanent --get-zones | tr ' ' '\n' | grep -qx zerostress; then
  firewall-cmd --permanent --new-zone=zerostress >/dev/null
fi
firewall-cmd --permanent --zone=zerostress --set-target=DROP >/dev/null
firewall-cmd --permanent --zone=zerostress --add-source=172.16.0.0/16 >/dev/null 2>&1 || true
if ! firewall-cmd --permanent --get-policies | tr ' ' '\n' | grep -qx zerostress-egress; then
  firewall-cmd --permanent --new-policy=zerostress-egress >/dev/null
fi
firewall-cmd --permanent --policy=zerostress-egress --add-ingress-zone=zerostress >/dev/null 2>&1 || true
firewall-cmd --permanent --policy=zerostress-egress --add-egress-zone=public >/dev/null 2>&1 || true
firewall-cmd --permanent --policy=zerostress-egress --set-target=ACCEPT >/dev/null
firewall-cmd --reload >/dev/null

say "forwarding: $(sysctl -n net.ipv4.ip_forward), zone zerostress: $(firewall-cmd --zone=zerostress --list-sources)"
