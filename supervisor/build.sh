#!/usr/bin/env bash
# Vet, test (with the race detector) and build the Go supervisor. Needs Go: runtime/go (./zs install runtime) or Go on PATH. Run as an unprivileged user.
# Output: build/supervisor/zerostress-supervisor (build/ is git-ignored). Standard library only: no go.sum.
set -euo pipefail
cd "$(dirname "$0")"
export PATH=$(cd .. && pwd)/runtime/go/bin:$PATH
OUT=$(cd .. && pwd)/build/supervisor
mkdir -p "$OUT"
go vet ./...
go test -count=1 -race ./...
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$OUT/zerostress-supervisor" .
ls -l "$OUT/zerostress-supervisor"
