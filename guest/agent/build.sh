#!/usr/bin/env bash
# Vet, test (with the race detector) and build the static guest agent. Needs Go in /opt/go. Run as an unprivileged user.
# Output: build/guest-agent/zerostress-agent (build/ is git-ignored).
set -euo pipefail
export PATH=/opt/go/bin:$PATH
cd "$(dirname "$0")"
OUT=$(cd ../.. && pwd)/build/guest-agent
mkdir -p "$OUT"
go vet ./...
go test -count=1 -race ./...
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/zerostress-agent" .
ls -l "$OUT/zerostress-agent"
