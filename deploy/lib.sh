# Shared by deploy/install.sh and deploy/steps/*.sh (spec 010). Sourced, never run on its own.
set -euo pipefail

S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) # the repository
F=$S/deploy/files                                   # every file that lands on the host, at its path there
# shellcheck source=versions.env
source "$S/deploy/versions.env"
export PATH=/opt/node/bin:/opt/go/bin:$PATH

# Builds run as the owner of the checkout, never as root: root-owned files in build/ would block the next build.
BUILD_USER=${BUILD_USER:-$(stat -c %U "$S")}
as_builder() {
  if [[ $(id -un) == "$BUILD_USER" ]]; then "$@"; else runuser -u "$BUILD_USER" -- env PATH="$PATH" HOME="$(getent passwd "$BUILD_USER" | cut -d: -f6)" "$@"; fi
}

need_root() { [[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }; }
say() { printf '  %s\n' "$*"; }

# put MODE OWNER:GROUP /path/on/host: copy deploy/files/path/on/host there
put() {
  install -D -m "$1" -o "${2%%:*}" -g "${2##*:}" "$F$3" "$3"
}

# fetch URL FILE sha256|sha512 SUM: download, refuse anything whose checksum is not the pinned one
fetch() {
  curl -fsSL --retry 3 -o "$2" "$1"
  echo "$4  $2" | "${3}sum" -c - >/dev/null || { echo "checksum does not match: $1" >&2; exit 1; }
}

# env_file NAME GROUP: /etc/zerostress/NAME.env from its example, once; afterwards only the names are compared
env_file() {
  local real=/etc/zerostress/$1.env example=$F/etc/zerostress/$1.env.example
  if [[ ! -e $real ]]; then
    install -m 0640 -o root -g "$2" "$example" "$real"
    say "$real created from the example: fill in what it asks for"
    return
  fi
  local set known n
  set=$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$real" | sort -u)
  known=$(sed -n 's/^#\{0,1\} *\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$example" | sort -u)
  for n in $(comm -13 <(echo "$set") <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$example" | sort -u)); do say "$real: $n is not set (the example sets it)"; done
  for n in $(comm -23 <(echo "$set") <(echo "$known")); do say "$real: $n is not read by anything (not in the example)"; done
}
