#!/usr/bin/env bash
# The host runtime, each from its publisher and checked against deploy/versions.env: Node (the web service), Go (builds
# the supervisor and the guest agent on the host), Firecracker, Caddy. A component already at the pinned version is
# left alone. Replacing Node or Caddy takes effect when the service restarts (steps 60-web.sh, install.sh web).
source "$(dirname "$0")/../lib.sh"
need_root
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# swap DIR: put $DIR.new in place of DIR
swap() { rm -rf "$1.old"; [[ -e $1 ]] && mv "$1" "$1.old"; mv "$1.new" "$1"; rm -rf "$1.old"; }

if [[ $(/opt/node/bin/node --version 2>/dev/null) != "v$NODE_VERSION" ]]; then
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$T/node.tar.xz" sha256 "$NODE_SHA256"
  rm -rf /opt/node.new && install -d -m 0755 /opt/node.new
  tar -xJf "$T/node.tar.xz" -C /opt/node.new --strip-components=1 --no-same-owner
  swap /opt/node
fi
say "node $(/opt/node/bin/node --version)"

if ! /opt/go/bin/go version 2>/dev/null | grep -q "go$GO_VERSION "; then
  fetch "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" "$T/go.tgz" sha256 "$GO_SHA256"
  rm -rf /opt/go.new && install -d -m 0755 /opt/go.new
  tar -xzf "$T/go.tgz" -C /opt/go.new --strip-components=1 --no-same-owner
  swap /opt/go
fi
say "$(/opt/go/bin/go version)"

if ! /opt/zerostress/bin/firecracker --version 2>/dev/null | grep -q "$FC_VERSION"; then
  fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" "$T/fc.tgz" sha256 "$FC_SHA256"
  tar -xzf "$T/fc.tgz" -C "$T"
  install -D -m 0755 -o root -g root "$T/release-$FC_VERSION-x86_64/firecracker-$FC_VERSION-x86_64" /opt/zerostress/bin/firecracker
  restorecon /opt/zerostress/bin/firecracker 2>/dev/null || true
fi
say "$(/opt/zerostress/bin/firecracker --version | head -1)"

if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" "$T/caddy.tgz" sha512 "$CADDY_SHA512"
  tar -xzf "$T/caddy.tgz" -C "$T" caddy
  install -m 0755 -o root -g root "$T/caddy" /usr/local/bin/caddy
fi
say "caddy $(/usr/local/bin/caddy version | cut -d' ' -f1)"
