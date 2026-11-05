#!/usr/bin/env bash
# Copy the working tree of another machine to the server (ssh host alias "vultr") as /opt/zerostress-src.
# The working copy on the server is a git repository (docs/SERVER.md): this script keeps its .git, and it REFUSES to
# run when that copy has uncommitted changes, because it would overwrite them (FORCE=1 overrides). It overwrites the
# tracked files and removes everything else outside .git and .build, build products included (agent and supervisor
# binaries, node_modules): build them again on the server. Run from anywhere in the repository.
set -euo pipefail
HOST=${HOST:-vultr}
FORCE=${FORCE:-0}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT"
tar --exclude=.git --exclude=node_modules --exclude='*.ext4' --exclude=zerostress-agent --exclude=zerostress-supervisor -cf - . |
  ssh -o BatchMode=yes "$HOST" 'FORCE='"$FORCE"'
    set -e
    mkdir -p /opt/zerostress-src
    if [ "$FORCE" != 1 ] && [ -d /opt/zerostress-src/.git ]; then
      dirty=$(git -c safe.directory=/opt/zerostress-src -C /opt/zerostress-src status --porcelain)
      if [ -n "$dirty" ]; then
        echo "the working copy on the server has uncommitted changes; commit them or run with FORCE=1:" >&2
        echo "$dirty" | head -10 >&2
        exit 3
      fi
    fi
    find /opt/zerostress-src -mindepth 1 -maxdepth 1 -not -name ".build" -not -name ".git" -exec rm -rf {} +
    tar --no-same-owner -xmf - -C /opt/zerostress-src
    find /opt/zerostress-src -type f \( -name "*.sh" -o -name "*.go" -o -name "*.mjs" -o -name "*.ts" -o -name "*.json" -o -name "*.service" -o -name zsnet -o -name "go.*" \) -not -path "*/.git/*" -exec sed -i "s/\r$//" {} +
    chmod +x /opt/zerostress-src/deploy/*.sh /opt/zerostress-src/deploy/zsnet /opt/zerostress-src/guest-image/*.sh /opt/zerostress-src/guest-image/test/*.sh
    chmod 755 /opt/zerostress-src
    chown -R linuxuser:linuxuser /opt/zerostress-src
    echo "synced to /opt/zerostress-src"'
