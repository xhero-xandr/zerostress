#!/usr/bin/env bash
# Copy the working tree to the dev server (ssh host alias "vultr") as /opt/zerostress-src.
# The server has no git checkout: this is the only way sources get there. Run from anywhere in the repo.
set -euo pipefail
HOST=${HOST:-vultr}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT"
tar --exclude=.git --exclude=node_modules --exclude='*.ext4' --exclude=zerostress-agent -cf - . |
  ssh -o BatchMode=yes "$HOST" '
    set -e
    mkdir -p /opt/zerostress-src
    find /opt/zerostress-src -mindepth 1 -maxdepth 1 -not -name ".build" -exec rm -rf {} +
    tar -xmf - -C /opt/zerostress-src
    find /opt/zerostress-src -type f \( -name "*.sh" -o -name "*.go" -o -name "*.mjs" -o -name "*.json" -o -name "*.service" -o -name zsnet -o -name "go.*" \) -exec sed -i "s/\r$//" {} +
    chmod +x /opt/zerostress-src/deploy/*.sh /opt/zerostress-src/deploy/zsnet /opt/zerostress-src/guest-image/*.sh /opt/zerostress-src/guest-image/test/*.sh
    chmod 755 /opt/zerostress-src
    chown -R linuxuser:linuxuser /opt/zerostress-src/guest-image/agent
    echo "synced to /opt/zerostress-src"'
