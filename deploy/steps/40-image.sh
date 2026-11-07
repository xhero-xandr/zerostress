#!/usr/bin/env bash
# The guest image (spec 004): build the guest agent (as the owner of the checkout), build the image from the pinned
# inputs with the real collector in build/image, check it against its manifest and install it into images/. Runs on
# its own cadence: the image is 1.5 GB and changes rarely.
source "$(dirname "$0")/../lib.sh"
need_root
need_root_dir

own_code
as_builder bash "$S/guest/agent/build.sh" | tail -1
bash "$S/guest/image/build.sh"
bash "$S/guest/image/install.sh"
