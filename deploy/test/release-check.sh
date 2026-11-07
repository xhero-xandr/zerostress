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
  rm -rf "$T/r"; git clone -q --no-tags "$S" "$T/r" 2>/dev/null
  git -C "$T/r" config user.name test; git -C "$T/r" config user.email test@test.invalid
  # the files of this working tree that carry the version, as they are now (committed or not)
  local f
  for f in CHANGELOG.md VERSION deploy/release.sh web/extension/public/manifest.json \
           web/package.json web/package-lock.json web/client/package.json web/client/package-lock.json \
           guest/collector/package.json guest/collector/package-lock.json; do
    mkdir -p "$(dirname "$T/r/$f")"; cp "$S/$f" "$T/r/$f"
  done
  git -C "$T/r" -c user.name=t -c user.email=t@t add -A >/dev/null; git -C "$T/r" -c user.name=t -c user.email=t@t commit -qm test --allow-empty
  git -C "$T/r" branch -qM main
}
v=$(tr -d '[:space:]' < "$S/VERSION")
refuses() { local why=$1; shift; if "$@" >/dev/null 2>&1; then no "accepted: $why"; else ok "refused: $why"; fi; }

fresh
if bash "$T/r/deploy/release.sh" check "$v" >/dev/null; then ok "the current version $v is consistent (control)"; else no "the current version $v is not consistent"; fi
refuses "a version that is not X.Y.Z" bash "$T/r/deploy/release.sh" check "1.0"
refuses "a version CHANGELOG.md has no section for" bash "$T/r/deploy/release.sh" check "99.0.0"
fresh; sed -i "s/^## \[$v\] - .*/## [$v]/" "$T/r/CHANGELOG.md"
refuses "a section without a date" bash "$T/r/deploy/release.sh" check "$v"
fresh; sed -i "s/\"version\": \"$v\"/\"version\": \"0.0.1\"/" "$T/r/web/extension/public/manifest.json"
refuses "an extension of another version" bash "$T/r/deploy/release.sh" check "$v"
fresh; echo 0.0.1 > "$T/r/VERSION"
refuses "VERSION saying another version" bash "$T/r/deploy/release.sh" check "$v"
for p in web web/client guest/collector; do
  fresh; sed -i "0,/\"version\": \"$v\"/s//\"version\": \"0.0.1\"/" "$T/r/$p/package.json"
  refuses "$p/package.json of another version" bash "$T/r/deploy/release.sh" check "$v"
  fresh; sed -i "0,/\"version\": \"$v\"/s//\"version\": \"0.0.1\"/" "$T/r/$p/package-lock.json"
  refuses "$p/package-lock.json of another version" bash "$T/r/deploy/release.sh" check "$v"
  fresh; awk -v v="$v" '/^    "": \{/ { on = 1 } on && !d && /"version":/ { sub("\"" v "\"", "\"0.0.1\""); d = 1 } { print }' "$T/r/$p/package-lock.json" > "$T/x" && mv "$T/x" "$T/r/$p/package-lock.json"
  refuses "$p/package-lock.json whose root package is of another version" bash "$T/r/deploy/release.sh" check "$v"
done
fresh; echo x >> "$T/r/README.md"
refuses "a working tree with changes" bash "$T/r/deploy/release.sh" tag "$v"
fresh; git -C "$T/r" checkout -qb other
refuses "a branch other than main" bash "$T/r/deploy/release.sh" tag "$v"
fresh
if bash "$T/r/deploy/release.sh" tag "$v" >/dev/null && git -C "$T/r" cat-file -t "v$v" | grep -q tag; then ok "a consistent release is tagged (annotated)"; else no "a consistent release was not tagged"; fi
refuses "a tag that exists already" bash "$T/r/deploy/release.sh" tag "$v"
[[ $(bash "$T/r/deploy/release.sh" notes "$v" | head -1) != "" ]] && ok "the notes are the version's section" || no "no notes for $v"

# set: a new version everywhere, its section made from [Unreleased]
fresh; sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Fixed\n- something/' "$T/r/CHANGELOG.md"
if bash "$T/r/deploy/release.sh" set 0.99.1 >/dev/null && bash "$T/r/deploy/release.sh" check 0.99.1 >/dev/null && [[ $(bash "$T/r/deploy/release.sh" notes 0.99.1) == *something* ]]; then ok "set writes a consistent new version, its notes from [Unreleased]"; else no "set did not make a consistent version"; fi
refuses "set with a version that is not X.Y.Z" bash "$T/r/deploy/release.sh" set "1.0"

# describe: the build's version
fresh
[[ $(bash "$T/r/deploy/release.sh" describe) =~ ^$v-dev\+g[0-9a-f]{7}$ ]] && ok "describe before any tag: X.Y.Z-dev+gHASH" || no "describe before any tag: $(bash "$T/r/deploy/release.sh" describe)"
git -C "$T/r" -c user.name=t -c user.email=t@t tag -a "v0.0.1" -m t
[[ $(bash "$T/r/deploy/release.sh" describe) =~ ^$v-dev\+0\.g[0-9a-f]{7}$ ]] && ok "describe after an older release only: X.Y.Z-dev+N.gHASH" || no "describe after an older tag: $(bash "$T/r/deploy/release.sh" describe)"
git -C "$T/r" -c user.name=t -c user.email=t@t commit -qm release --allow-empty
git -C "$T/r" -c user.name=t -c user.email=t@t tag -a "v$v" -m t
[[ $(bash "$T/r/deploy/release.sh" describe) == "$v" ]] && ok "describe on its release tag: X.Y.Z" || no "describe on the tag: $(bash "$T/r/deploy/release.sh" describe)"
git -C "$T/r" -c user.name=t -c user.email=t@t commit -qm later --allow-empty
[[ $(bash "$T/r/deploy/release.sh" describe) =~ ^$v\+1\.g[0-9a-f]{7}$ ]] && ok "describe a commit later: X.Y.Z+1.gHASH" || no "describe later: $(bash "$T/r/deploy/release.sh" describe)"
echo x >> "$T/r/README.md"
[[ $(bash "$T/r/deploy/release.sh" describe) =~ ^$v\+1\.g[0-9a-f]{7}\.dirty$ ]] && ok "describe with changes: .dirty" || no "describe dirty: $(bash "$T/r/deploy/release.sh" describe)"

echo "release-check: $pass passed, $fail failed"
(( fail == 0 ))
