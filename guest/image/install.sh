#!/usr/bin/env bash
# Install the output of build.sh into the project's images/ (read-only for services). Run as root.
# Usage: install.sh [OUT_DIR]   (default: build/image/out)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$REPO/build/image/out}
DEST=$REPO/images

[[ -f $OUT/manifest.json ]] || { echo "no manifest.json in $OUT" >&2; exit 1; }
want=$(grep -A1 '"image"' "$OUT/manifest.json" | grep -o '"sha256": "[0-9a-f]*"' | cut -d'"' -f4)
got=$(sha256sum "$OUT/guest-rootfs.ext4" | awk '{print $1}')
[[ $want == "$got" ]] || { echo "image checksum does not match manifest.json" >&2; exit 1; }

install -d -m 0755 -o root -g root "$DEST"
for f in "$OUT"/vmlinux-*; do install -m 0644 -o root -g root "$f" "$DEST/$(basename "$f")"; done
# every microVM reads this very file (read-only, review D3): it is replaced by a rename, never written in place, so a VM
# that starts meanwhile gets the old image or the new one whole, and a running one keeps reading the old
install -m 0644 -o root -g root "$OUT/guest-rootfs.ext4" "$DEST/.guest-rootfs.ext4.new"
mv -f "$DEST/.guest-rootfs.ext4.new" "$DEST/guest-rootfs.ext4"
[[ -f $OUT/packages.txt ]] && install -m 0644 -o root -g root "$OUT/packages.txt" "$DEST/packages.txt"
install -m 0644 -o root -g root "$OUT/manifest.json" "$DEST/manifest.json"
ls -lh "$DEST"
