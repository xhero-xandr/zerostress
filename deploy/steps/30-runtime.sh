#!/usr/bin/env bash
# The runtime, each from its publisher and checked against deploy/versions.env: Node and Go into runtime/, Firecracker
# and Caddy into bin/. A component already at the pinned version is left alone. A new Node or Caddy takes effect when
# its service restarts.
source "$(dirname "$0")/../lib.sh"
need_root
need_root_dir
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# unpack ARCHIVE DIR: a fresh DIR from the archive's top directory, swapped in whole
unpack() {
  rm -rf "$2.new" && install -d -m 0755 "$2.new"
  tar -xf "$1" -C "$2.new" --strip-components=1 --no-same-owner
  rm -rf "$2.old"; [[ -e $2 ]] && mv "$2" "$2.old"; mv "$2.new" "$2"; rm -rf "$2.old"
}

if [[ $("$S/runtime/node/bin/node" --version 2>/dev/null) != "v$NODE_VERSION" ]]; then
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$T/node.tar.xz" sha256 "$NODE_SHA256"
  unpack "$T/node.tar.xz" "$S/runtime/node"
fi
say "node $("$S/runtime/node/bin/node" --version)"

if ! "$S/runtime/go/bin/go" version 2>/dev/null | grep -q "go$GO_VERSION "; then
  fetch "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" "$T/go.tgz" sha256 "$GO_SHA256"
  unpack "$T/go.tgz" "$S/runtime/go"
fi
say "$("$S/runtime/go/bin/go" version)"

if ! "$S/bin/firecracker" --version 2>/dev/null | grep -q "$FC_VERSION"; then
  fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz" "$T/fc.tgz" sha256 "$FC_SHA256"
  tar -xzf "$T/fc.tgz" -C "$T"
  install -m 0755 -o root -g root "$T/release-$FC_VERSION-x86_64/firecracker-$FC_VERSION-x86_64" "$S/bin/firecracker"
fi
say "$("$S/bin/firecracker" --version | head -1)"

if ! "$S/bin/caddy" version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" "$T/caddy.tgz" sha512 "$CADDY_SHA512"
  tar -xzf "$T/caddy.tgz" -C "$T" caddy
  install -m 0755 -o root -g root "$T/caddy" "$S/bin/caddy"
fi
say "caddy $("$S/bin/caddy" version | cut -d' ' -f1)"
restorecon -R "$S/bin" "$S/runtime"
