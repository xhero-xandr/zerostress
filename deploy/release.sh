#!/usr/bin/env bash
# Versions and releases (CHANGELOG.md). One version for the whole project, written in VERSION; every other place that
# carries a version must say the same, and a release is an annotated tag vX.Y.Z on main.
#   deploy/release.sh set X.Y.Z     write X.Y.Z into VERSION, the extension's manifest, the package.json and lock files;
#                                   date the CHANGELOG section (made from [Unreleased] when there is none yet)
#   deploy/release.sh check [X.Y.Z] every place says the same version (VERSION's when none is given), and CHANGELOG.md
#                                   has a dated, non-empty section for it (the release workflow runs this too)
#   deploy/release.sh tag X.Y.Z     check, plus a clean tree on main, then the annotated tag vX.Y.Z (not pushed)
#   deploy/release.sh notes X.Y.Z   print the section of CHANGELOG.md for X.Y.Z (the release's notes)
#   deploy/release.sh describe      the version of this build: X.Y.Z on its own tag, X.Y.Z+N.gHASH N commits after it,
#                                   X.Y.Z-dev+N.gHASH before X.Y.Z is tagged (N commits after the previous release), with
#                                   .dirty for uncommitted changes; what the site and the supervisor report
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd)
cmd=${1:-}; v=${2:-}
die() { echo "release: $*" >&2; exit 1; }
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# every file that carries the version: VERSION itself, the extension, and the npm packages with their lock files
PACKAGES=(web web/client guest/collector)
current() { tr -d '[:space:]' < "$S/VERSION"; }
json_version() { sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }
lock_root_version() { awk '/^    "": \{/ { on = 1 } on && /"version":/ { gsub(/.*"version": *"|".*/, ""); print; exit }' "$1"; }

notes() { awk -v h="## [$v]" 'index($0, h) == 1 { on = 1; next } on && /^## \[/ { exit } on' "$S/CHANGELOG.md" | sed -e '/./,$!d'; }

check() {
  [[ $(current) == "$v" ]] || die "VERSION says '$(current)', not $v"
  local m p
  m=$(json_version "$S/web/extension/public/manifest.json")
  [[ $m == "$v" ]] || die "web/extension/public/manifest.json says version '$m', not $v"
  for p in "${PACKAGES[@]}"; do
    m=$(json_version "$S/$p/package.json"); [[ $m == "$v" ]] || die "$p/package.json says version '$m', not $v"
    m=$(json_version "$S/$p/package-lock.json"); [[ $m == "$v" ]] || die "$p/package-lock.json says version '$m', not $v"
    m=$(lock_root_version "$S/$p/package-lock.json"); [[ $m == "$v" ]] || die "$p/package-lock.json (its root package) says version '$m', not $v"
  done
  grep -Eq "^## \[$v\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" "$S/CHANGELOG.md" || die "CHANGELOG.md has no dated section '## [$v] - YYYY-MM-DD'"
  [[ -n $(notes | tr -d '[:space:]') ]] || die "the section for $v in CHANGELOG.md is empty"
}

set_version() {
  local f p
  printf '%s\n' "$v" > "$S/VERSION"
  sed -i "0,/^  \"version\": *\"[^\"]*\"/s//  \"version\": \"$v\"/" "$S/web/extension/public/manifest.json"
  for p in "${PACKAGES[@]}"; do
    sed -i "0,/^  \"version\": *\"[^\"]*\"/s//  \"version\": \"$v\"/" "$S/$p/package.json"
    f="$S/$p/package-lock.json"
    sed -i "0,/^  \"version\": *\"[^\"]*\"/s//  \"version\": \"$v\"/" "$f"
    awk -v v="$v" '/^    "": \{/ { on = 1 } on && !done && /"version":/ { sub(/"version": *"[^"]*"/, "\"version\": \"" v "\""); done = 1 } { print }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
  if ! grep -q "^## \[$v\]" "$S/CHANGELOG.md"; then
    # the entries under [Unreleased] become the new version's section
    awk -v h="## [$v] - $(date -u +%F)" '{ print } /^## \[Unreleased\]$/ { print ""; print h }' "$S/CHANGELOG.md" > "$S/CHANGELOG.md.tmp" && mv "$S/CHANGELOG.md.tmp" "$S/CHANGELOG.md"
  fi
}

describe() {
  local base d
  base=$(current)
  [[ $base =~ $SEMVER ]] || die "VERSION does not hold X.Y.Z"
  # the nearest release tag; without one (before the first release) the commit alone
  if d=$(git -C "$S" describe --tags --match 'v[0-9]*.[0-9]*.[0-9]*' --long --dirty=.dirty --abbrev=7 2>/dev/null) && [[ $d =~ ^v(.+)-([0-9]+)-(g[0-9a-f]+)(\.dirty)?$ ]]; then
    local tag=${BASH_REMATCH[1]} n=${BASH_REMATCH[2]} hash=${BASH_REMATCH[3]} dirty=${BASH_REMATCH[4]}
    # VERSION ahead of the last tag: a build on the way to that release
    local pre=''; [[ $tag == "$base" ]] || pre='-dev'
    if [[ $n == 0 && -z $dirty && -z $pre ]]; then echo "$base"
    else echo "$base$pre+$n.$hash$dirty"; fi
  elif d=$(git -C "$S" describe --always --dirty=.dirty --abbrev=7 2>/dev/null); then echo "$base-dev+g$d"
  else echo "$base-dev+unknown"; fi
}

case $cmd in
  describe) describe; exit 0 ;;
  check) v=${v:-$(current)} ;;
esac
[[ $v =~ $SEMVER ]] || die "version must be X.Y.Z, got '$v'"
case $cmd in
  set) set_version; check; echo "version $v written; review CHANGELOG.md, commit, then: ./zs release $v" ;;
  check) check; echo "release $v: consistent" ;;
  notes) notes ;;
  tag)
    check
    [[ -z $(git -C "$S" status --porcelain) ]] || die "the working tree has changes: commit them first"
    [[ $(git -C "$S" rev-parse --abbrev-ref HEAD) == main ]] || die "not on main"
    ! git -C "$S" rev-parse -q --verify "refs/tags/v$v" >/dev/null || die "tag v$v exists already"
    git -C "$S" tag -a "v$v" -m "ZeroStress $v" -m "$(notes)"
    echo "tagged v$v at $(git -C "$S" rev-parse --short HEAD). Publish it: git push origin main && git push origin v$v"
    ;;
  *) die "usage: release.sh set|check|tag|notes X.Y.Z, or release.sh describe" ;;
esac
