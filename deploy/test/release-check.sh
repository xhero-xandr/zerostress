#!/usr/bin/env bash
# deploy/release.sh refuses an inconsistent release, each check on its own: a throwaway clone of this checkout, one
# thing broken at a time. Runs without root and without the network.
set -euo pipefail
S=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok() { echo "  ok    $*"; pass=$((pass + 1)); }
no() { echo "  FAIL  $*"; fail=$((fail + 1)); }
fresh() {
  rm -rf "$T/r"; git clone -q "$S" "$T/r" 2>/dev/null
  git -C "$T/r" config user.name test; git -C "$T/r" config user.email test@test.invalid
  cp "$S/CHANGELOG.md" "$S/deploy/release.sh" "$T/r/" 2>/dev/null; mkdir -p "$T/r/deploy" "$T/r/web/extension/public"
  cp "$S/deploy/release.sh" "$T/r/deploy/release.sh"; cp "$S/web/extension/public/manifest.json" "$T/r/web/extension/public/manifest.json"
  git -C "$T/r" -c user.name=t -c user.email=t@t add -A >/dev/null; git -C "$T/r" -c user.name=t -c user.email=t@t commit -qm test --allow-empty
  git -C "$T/r" branch -qM main
}
v=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$S/web/extension/public/manifest.json" | head -1)
refuses() { local why=$1; shift; if "$@" >/dev/null 2>&1; then no "accepted: $why"; else ok "refused: $why"; fi; }

fresh
if bash "$T/r/deploy/release.sh" check "$v" >/dev/null; then ok "the current version $v is consistent (control)"; else no "the current version $v is not consistent"; fi
refuses "a version that is not X.Y.Z" bash "$T/r/deploy/release.sh" check "1.0"
refuses "a version CHANGELOG.md has no section for" bash "$T/r/deploy/release.sh" check "99.0.0"
fresh; sed -i "s/^## \[$v\] - .*/## [$v]/" "$T/r/CHANGELOG.md"
refuses "a section without a date" bash "$T/r/deploy/release.sh" check "$v"
fresh; sed -i "s/\"version\": \"$v\"/\"version\": \"0.0.1\"/" "$T/r/web/extension/public/manifest.json"
refuses "an extension of another version" bash "$T/r/deploy/release.sh" check "$v"
fresh; echo x >> "$T/r/README.md"
refuses "a working tree with changes" bash "$T/r/deploy/release.sh" tag "$v"
fresh; git -C "$T/r" checkout -qb other
refuses "a branch other than main" bash "$T/r/deploy/release.sh" tag "$v"
fresh
if bash "$T/r/deploy/release.sh" tag "$v" >/dev/null && git -C "$T/r" cat-file -t "v$v" | grep -q tag; then ok "a consistent release is tagged (annotated)"; else no "a consistent release was not tagged"; fi
refuses "a tag that exists already" bash "$T/r/deploy/release.sh" tag "$v"
[[ $(bash "$T/r/deploy/release.sh" notes "$v" | head -1) != "" ]] && ok "the notes are the version's section" || no "no notes for $v"

echo "release-check: $pass passed, $fail failed"
(( fail == 0 ))
