# Shared by ./zs and deploy/steps/*.sh (spec 010). Sourced, never run on its own.
#
# Everything lives under one project directory, the checkout itself: /zerostress on the server. Next to the code
# (git) sit the git-ignored places the installer and the services fill:
#   config/   web.env, supervisor.env (edited by a person), Caddyfile (made by the installer)
#   bin/      firecracker, zsvm, zsnet, caddy, zerostress-supervisor   (root-owned: zsvm and zsnet run as root)
#   runtime/  node, go
#   images/   the guest image
#   data/     supervisor/ (runs, results, db), web/ (reports), geo/, caddy/ (certificates)
#   logs/     web.log, supervisor.log, caddy.log
#   run/      supervisor.sock
#   build/    everything a build makes
set -euo pipefail

S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) # the project directory
ROOT=/zerostress                                   # where it must be on a server (units, sudoers and zsvm say so)
F=$S/deploy/files                                  # the few files that must live in system directories, at their path
# shellcheck source=versions.env
source "$S/deploy/versions.env"
export PATH=$S/runtime/node/bin:$S/runtime/go/bin:$PATH

# The code (the checkout) belongs to CODE_USER, a system account with no sudo and no login: builds run third-party
# tools (npm packages, vite, go), and they must not run as root or as an administrator with sudo. Builds run as the
# owner of the checkout, never as root: root-owned files in build/ would block the next build.
CODE_USER=zerostress
# the git-ignored places that keep their own owners (root, a service): own_code leaves them alone
OWN_PLACES=(bin runtime images data logs run config/web.env config/supervisor.env config/Caddyfile)

# System libraries the Playwright Chromium needs on a Rocky host (found missing on a fresh one, 8 Nov 2026): the browser
# of web/tools/panel-check.mjs and web/client's e2e check. Its own download is by the owner of the checkout (60-web.sh).
CHROMIUM_LIBS=(atk at-spi2-atk at-spi2-core alsa-lib libXcomposite libXdamage libXfixes libXrandr)

# code_find FIND-ACTION...: the files of the checkout that are not CODE_USER's, outside OWN_PLACES
code_find() {
  local prune=() p
  for p in "${OWN_PLACES[@]}"; do prune+=(-o -path "$S/$p"); done
  find "$S" \( "${prune[@]:1}" \) -prune -o ! -user "$CODE_USER" "$@"
}
# own_code: give the checkout back to CODE_USER, whatever a person or a tool did as root (git as root, an editor, a
# test run). No-op until the account exists (`./zs install host` makes it).
own_code() {
  id "$CODE_USER" >/dev/null 2>&1 || return 0
  code_find -exec chown -h "$CODE_USER:$CODE_USER" {} +
}

# The people who work in the checkout over SSH (VS Code, a shell) are not CODE_USER, and the default login differs from
# machine to machine (rocky, vcuser, linuxuser...), so no name is guessed: they are the administrators the system itself
# knows, the human members of the group wheel (RHEL) or sudo (Debian), or exactly ADMIN_USER when that is set.
# Git's author for the repository is the project's, set once and only if unset.
GIT_NAME=${GIT_NAME:-xhero-xandr}
GIT_EMAIL=${GIT_EMAIL:-devp.xandr@gmail.com}
admin_users() {
  local u
  if [[ -n ${ADMIN_USER:-} ]]; then id "$ADMIN_USER" >/dev/null 2>&1 && echo "$ADMIN_USER"; return 0; fi
  for u in $(getent group wheel sudo | cut -d: -f4 | tr ',' '\n' | sort -u); do
    [[ $u != root && $(id -u "$u" 2>/dev/null || echo 0) -ge 1000 ]] && echo "$u"
  done
  return 0
}

# admin_access: rwX on the checkout for each administrator by ACL (the files stay CODE_USER's, so verify stays happy; the
# ones an administrator makes become theirs until own_code, which ./zs install and update run), git's safe.directory
# for them, and the repository's author. The places of OWN_PLACES (root's and the services') are left out on purpose.
admin_access() {
  local users u p prune=()
  users=$(admin_users)
  [[ -n $users ]] || { say "admin: no administrator (group wheel or sudo) and no ADMIN_USER: the checkout stays closed to people"; return 0; }
  command -v setfacl >/dev/null || dnf install -y acl >/dev/null
  for p in "${OWN_PLACES[@]}"; do prune+=(-o -path "$S/$p"); done
  for u in $users; do
    find "$S" \( "${prune[@]:1}" \) -prune -o -user "$CODE_USER" -exec setfacl -m "u:$u:rwX" {} +
    find "$S" \( "${prune[@]:1}" \) -prune -o -user "$CODE_USER" -type d -exec setfacl -d -m "u:$u:rwX" {} +
    runuser -u "$u" -- git config --global --get-all safe.directory 2>/dev/null | grep -qx "$S" || runuser -u "$u" -- git config --global --add safe.directory "$S"
  done
  as_builder git -C "$S" config user.name >/dev/null 2>&1 || as_builder git -C "$S" config user.name "$GIT_NAME"
  as_builder git -C "$S" config user.email >/dev/null 2>&1 || as_builder git -C "$S" config user.email "$GIT_EMAIL"
  say "admin: $(echo $users) may work in the checkout; git author $(as_builder git -C "$S" config user.name)"
}

# has_ssh_key: somebody other than root can come back in by key, so closing passwords and root over SSH cannot lock
# everybody out
has_ssh_key() {
  local h
  for h in $(getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 && $7 !~ /nologin|false/ {print $6}'); do
    [[ -s $h/.ssh/authorized_keys ]] && return 0
  done
  return 1
}

as_builder() {
  local u=${BUILD_USER:-$(stat -c %U "$S")}
  if [[ $(id -un) == "$u" ]]; then "$@"; else runuser -u "$u" -- env PATH="$PATH" HOME="$(getent passwd "$u" | cut -d: -f6)" "$@"; fi
}

need_root() { [[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }; }
need_root_dir() {
  [[ $S == "$ROOT" ]] || { echo "the project must be at $ROOT on a server (it is at $S): the units, sudoers rules and zsvm name that path" >&2; exit 1; }
}
say() { printf '  %s\n' "$*"; }

# put MODE OWNER:GROUP /path/on/host: copy deploy/files/path/on/host there
put() { install -D -m "$1" -o "${2%%:*}" -g "${2##*:}" "$F$3" "$3"; }

# fetch URL FILE sha256|sha512 SUM: download, refuse anything whose checksum is not the pinned one
fetch() {
  curl -fsSL --retry 3 -o "$2" "$1"
  echo "$4  $2" | "${3}sum" -c - >/dev/null || { echo "checksum does not match: $1" >&2; exit 1; }
}

# SELinux types for the project tree under PREFIX (spec 010; tested 6 November 2026: systemd may not create the guest
# console log in a usr_t directory, which is what a new directory under / or /opt gets)
selinux_rules() {
  local p=$1 rule
  command -v semanage >/dev/null || return 0
  for rule in "usr_t|$p(/.*)?" "bin_t|$p/bin(/.*)?" "bin_t|$p/runtime/[^/]+/bin(/.*)?" "etc_t|$p/config(/.*)?" \
    "var_lib_t|$p/data(/.*)?" "var_lib_t|$p/run(/.*)?" "var_log_t|$p/logs(/.*)?"; do
    semanage fcontext -a -t "${rule%%|*}" "${rule#*|}" 2>/dev/null || semanage fcontext -m -t "${rule%%|*}" "${rule#*|}"
  done
}
selinux_rules_remove() {
  local p=$1 rule
  for rule in "$p(/.*)?" "$p/bin(/.*)?" "$p/runtime/[^/]+/bin(/.*)?" "$p/config(/.*)?" "$p/data(/.*)?" "$p/run(/.*)?" "$p/logs(/.*)?"; do
    semanage fcontext -d "$rule" 2>/dev/null || true
  done
}

# env_file NAME GROUP: config/NAME.env from its example, once; afterwards only the names are compared
env_file() {
  local real=$S/config/$1.env example=$S/config/$1.env.example
  if [[ ! -e $real ]]; then
    install -m 0640 -o root -g "$2" "$example" "$real"
    say "config/$1.env created from the example: fill in what it asks for (./zs config $1)"
    return
  fi
  local set known n
  set=$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$real" | sort -u)
  known=$(sed -n 's/^#\{0,1\} *\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$example" | sort -u)
  for n in $(comm -13 <(echo "$set") <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$example" | sort -u)); do say "config/$1.env: $n is not set (the example sets it)"; done
  for n in $(comm -23 <(echo "$set") <(echo "$known")); do say "config/$1.env: $n is not read by anything (not in the example)"; done
}
