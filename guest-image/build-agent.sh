#!/usr/bin/env bash
# Build the static guest agent (needs Go in /opt/go). Output: guest-image/agent/zerostress-agent (git-ignored).
# Runs the tests first. Run as an unprivileged user on the dev server.
set -euo pipefail
export PATH=/opt/go/bin:$PATH
cd "$(dirname "$0")/agent"
go vet ./...
go test -count=1 -race ./...
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o zerostress-agent .
ls -l zerostress-agent
