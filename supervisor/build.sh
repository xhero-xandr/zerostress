#!/usr/bin/env bash
# Vet, test (with the race detector) and build the Go supervisor. Needs Go in /opt/go. Run as an unprivileged user.
# Output: build/supervisor/zerostress-supervisor (build/ is git-ignored). Standard library only: no go.sum.
set -euo pipefail
export PATH=/opt/go/bin:$PATH
cd "$(dirname "$0")"
OUT=$(cd .. && pwd)/build/supervisor
mkdir -p "$OUT"
go vet ./...
go test -count=1 -race ./...
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/zerostress-supervisor" .
ls -l "$OUT/zerostress-supervisor"
