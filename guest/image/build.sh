#!/usr/bin/env bash
# Build the guest root filesystem image from pinned inputs (spec 004, section 4). Run as root on the host.
#
#   [AGENT_BIN=...] [COLLECTOR_ENTRY=...] [BUILD_DIR=...] ./build.sh
#
# Defaults: the agent from guest/agent/build.sh and the real collector. Tests that need the stub collector say so:
# COLLECTOR_ENTRY=deploy/test/stub-collector.mjs (the stub used to be the default, and a production image was once built
# with it by mistake).
#
# Output (in $BUILD_DIR/out, default build/image/out): guest-rootfs.ext4, vmlinux-<ver>, manifest.json. Nothing is
# installed into images/: install.sh does that after checking the manifest.
set -euo pipefail
export LC_ALL=C DEBIAN_FRONTEND=noninteractive

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

# ---- pinned inputs: deploy/versions.env (spec 010, 4.4) -----------------------------------------------------
# shellcheck source=../../deploy/versions.env
source "$REPO/deploy/versions.env"
CI_PREFIX=$GUEST_CI_PREFIX
CI_URL=https://s3.amazonaws.com/spec.ccfc.min/$CI_PREFIX   # path-style: the bucket name contains dots
ROOTFS_NAME=$GUEST_ROOTFS_NAME
ROOTFS_SHA256=$GUEST_ROOTFS_SHA256
KERNEL_VERSION=$GUEST_KERNEL_VERSION
KERNEL_SHA256=$GUEST_KERNEL_SHA256
IMG_SIZE=5G
# ---------------------------------------------------------------------------------------------------------

AGENT_BIN=${AGENT_BIN:-$REPO/build/guest-agent/zerostress-agent}
[[ -x $AGENT_BIN ]] || { echo "no agent at $AGENT_BIN: run guest/agent/build.sh first"; exit 1; }
COLLECTOR_ENTRY=${COLLECTOR_ENTRY:-$REPO/guest/collector/collect.mjs}
W=${BUILD_DIR:-$REPO/build/image}
OUT=$W/out
R=$W/mnt
IMG=$OUT/guest-rootfs.ext4

# runtime libraries and fonts for Chromium headless shell (Latin, Cyrillic, CJK, emoji)
APT_PACKAGES="ca-certificates libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64
 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1
 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libfontconfig1 libfreetype6
 fonts-noto-color-emoji fonts-unifont fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei
 fonts-tlwg-loma-otf fonts-freefont-ttf xfonts-cyrillic xfonts-scalable"

die() { echo "build: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ -x $AGENT_BIN ]] || die "AGENT_BIN is not an executable file"

umount_all() {
  for m in dev/pts dev sys proc ""; do
    mountpoint -q "$R/$m" 2>/dev/null && umount -l "$R/$m" || true
  done
}
trap umount_all EXIT

fetch() { # url dest sha256
  if [[ -f $2 ]] && echo "$3  $2" | sha256sum -c - >/dev/null 2>&1; then return; fi
  curl -fL --retry 3 --retry-delay 2 -o "$2" "$1"
  echo "$3  $2" | sha256sum -c - || die "checksum mismatch: $2"
}

mkdir -p "$W/dl" "$OUT"
rm -rf "$W/tree" "$IMG"

echo "== 1. download pinned inputs"
fetch "$CI_URL/$ROOTFS_NAME" "$W/dl/$ROOTFS_NAME" "$ROOTFS_SHA256"
fetch "$CI_URL/vmlinux-$KERNEL_VERSION" "$W/dl/vmlinux-$KERNEL_VERSION" "$KERNEL_SHA256"
NODE_TGZ=node-v$NODE_VERSION-linux-x64.tar.xz
curl -fsSL --retry 3 -o "$W/dl/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
[[ $(awk -v f="$NODE_TGZ" '$2==f{print $1}' "$W/dl/SHASUMS256.txt") == "$NODE_SHA256" ]] || die "the pinned checksum of $NODE_TGZ is not the publisher's"
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ" "$W/dl/$NODE_TGZ" "$NODE_SHA256"

echo "== 2. unpack CI root filesystem and create the image"
unsquashfs -q -f -d "$W/tree" "$W/dl/$ROOTFS_NAME"
truncate -s "$IMG_SIZE" "$IMG"
mkfs.ext4 -q -F -L qroot -d "$W/tree" "$IMG"
rm -rf "$W/tree"

echo "== 3. mount and prepare chroot"
mkdir -p "$R"
mount -o loop "$IMG" "$R"
mount -t proc proc "$R/proc"
mount -t sysfs sysfs "$R/sys"
mount --bind /dev "$R/dev"
mount -t devpts devpts "$R/dev/pts"
mkdir -p "$R/tmp" "$R/var/tmp"
chmod 1777 "$R/tmp" "$R/var/tmp"
mkdir -p "$R/var/cache/apt/archives/partial" "$R/var/lib/apt/lists/partial" "$R/var/log/apt"
rm -f "$R/etc/resolv.conf"
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' >"$R/etc/resolv.conf"   # build time only; overlay rewrites it

inchroot() {
  chroot "$R" /usr/bin/env -i HOME=/root LC_ALL=C DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers "$@"
}

echo "== 4. apt packages"
inchroot apt-get update -qq
# shellcheck disable=SC2086
inchroot apt-get install -y -qq --no-install-recommends $APT_PACKAGES
inchroot apt-get clean
rm -rf "$R"/var/lib/apt/lists/* "$R"/usr/share/doc/* "$R"/usr/share/man/* "$R"/var/cache/apt/*.bin

echo "== 5. Node $NODE_VERSION"
install -d "$R/opt/node"
tar -xJf "$W/dl/$NODE_TGZ" -C "$R/opt/node" --strip-components=1
inchroot node --version

echo "== 6. collector dependencies (npm ci --ignore-scripts) and browser"
install -d -m 0755 "$R/opt/collector"
install -m 0644 "$REPO/guest/collector/package.json" "$REPO/guest/collector/package-lock.json" "$R/opt/collector/"
inchroot sh -c 'cd /opt/collector && npm ci --ignore-scripts --no-audit --no-fund'
inchroot sh -c 'cd /opt/collector && npx playwright install --only-shell chromium'
PW_VERSION=$(inchroot node -p "require('/opt/collector/node_modules/playwright/package.json').version")

echo "== 7. unprivileged user"
inchroot useradd -m -u 1001 -s /usr/sbin/nologin pw
chown -R root:root "$R/opt/node" "$R/opt/collector" "$R/opt/pw-browsers"
chmod -R go-w "$R/opt/node" "$R/opt/collector" "$R/opt/pw-browsers"
install -d -m 0700 -o 1001 -g 1001 "$R/home/pw" 2>/dev/null || true

echo "== 8. unmount, check"
umount_all
e2fsck -fn "$IMG" >/dev/null

echo "== 9. overlay (agent, unit, DNS, no SSH)"
bash "$HERE/apply-overlay.sh" "$IMG" "$AGENT_BIN" "$COLLECTOR_ENTRY" | tail -2

echo "== 10. manifest"
cp "$W/dl/vmlinux-$KERNEL_VERSION" "$OUT/vmlinux-$KERNEL_VERSION"
IMG_SHA256=$(sha256sum "$IMG" | awk '{print $1}')
cat >"$OUT/manifest.json" <<EOF
{
  "built_at": "$(date -u +%FT%TZ)",
  "repo_commit": "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "ci_prefix": "$CI_PREFIX",
  "rootfs_upstream_sha256": "$ROOTFS_SHA256",
  "kernel": {"file": "vmlinux-$KERNEL_VERSION", "sha256": "$KERNEL_SHA256"},
  "node": {"version": "$NODE_VERSION", "sha256": "$NODE_SHA256"},
  "playwright": "$PW_VERSION",
  "agent_sha256": "$(sha256sum "$AGENT_BIN" | awk '{print $1}')",
  "collector_entry_sha256": "$(cat "$COLLECTOR_ENTRY" "$(dirname "$COLLECTOR_ENTRY")"/lib/*.mjs 2>/dev/null | sha256sum | awk '{print $1}')",
  "image": {"file": "guest-rootfs.ext4", "sha256": "$IMG_SHA256"}
}
EOF
cat "$OUT/manifest.json"
echo "build ok: $OUT"
