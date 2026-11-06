#!/usr/bin/env bash
# Install the zsvm helper and its sudoers rule (specs 002 and 006). Idempotent. Run as root.
set -euo pipefail
cd "$(dirname "$0")"

install -m 0755 -o root -g root helpers/zsvm /opt/zerostress/bin/zsvm
chcon -t bin_t /opt/zerostress/bin/zsvm 2>/dev/null || true

# the supervisor may run exactly these commands; zsvm itself validates every argument again
cat >/etc/sudoers.d/zerostress-vm <<'EOF'
zerostress-sup ALL=(root) NOPASSWD: /opt/zerostress/bin/zsvm run [0-3] * * *, /opt/zerostress/bin/zsvm stop *, /opt/zerostress/bin/zsvm recover
EOF
chmod 0440 /etc/sudoers.d/zerostress-vm
visudo -cf /etc/sudoers.d/zerostress-vm
sudo -l -U zerostress-sup | grep zsvm
