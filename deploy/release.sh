#!/usr/bin/env bash
# Releases (CHANGELOG.md): one version for the whole project, a tag vX.Y.Z on main.
#   deploy/release.sh check X.Y.Z   the version is consistent: a dated section in CHANGELOG.md, the extension's manifest
#                                   says X.Y.Z (used by the release workflow too)
#   deploy/release.sh tag X.Y.Z     check, plus a clean tree on main, then an annotated tag vX.Y.Z (not pushed)
#   deploy/release.sh notes X.Y.Z   print the section of CHANGELOG.md for X.Y.Z (the release's notes)
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd)
cmd=${1:-}; v=${2:-}
die() { echo "release: $*" >&2; exit 1; }
[[ $v =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "version must be X.Y.Z, got '$v'"

notes() { awk -v h="## [$v]" 'index($0, h) == 1 { on = 1; next } on && /^## \[/ { exit } on' "$S/CHANGELOG.md" | sed -e '/./,$!d'; }

check() {
  grep -Eq "^## \[$v\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" "$S/CHANGELOG.md" || die "CHANGELOG.md has no dated section '## [$v] - YYYY-MM-DD'"
  [[ -n $(notes | tr -d '[:space:]') ]] || die "the section for $v in CHANGELOG.md is empty"
  local m
  m=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$S/web/extension/public/manifest.json" | head -1)
  [[ $m == "$v" ]] || die "web/extension/public/manifest.json says version '$m', not $v"
}

case $cmd in
  check) check; echo "release $v: consistent" ;;
  notes) notes ;;
  tag)
    check
    [[ -z $(git -C "$S" status --porcelain) ]] || die "the working tree has changes: commit them first"
    [[ $(git -C "$S" rev-parse --abbrev-ref HEAD) == main ]] || die "not on main"
    ! git -C "$S" rev-parse -q --verify "refs/tags/v$v" >/dev/null || die "tag v$v exists already"
    git -C "$S" tag -a "v$v" -m "ZeroStress $v" -m "$(notes)"
    echo "tagged v$v at $(git -C "$S" rev-parse --short HEAD). Publish it: git push origin v$v"
    ;;
  *) die "usage: release.sh check|tag|notes X.Y.Z" ;;
esac
