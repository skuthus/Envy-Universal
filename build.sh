#!/usr/bin/env bash
# Build a real, standalone Envy you can run without a terminal or a dev
# server. A release compile takes several minutes the first time.
#
# Runs the headless pre-ship gate (./scripts/ship-check.sh --no-gui) first, so
# a bundle can never be built from a tree that does not pass. ENVY_SKIP_GATE=1
# skips it. The gate does its own release build; the one below then reuses that
# work and is incremental, so the gate costs little on top.
#
# Produces:
#   target/release/envynote                         <- run this directly
#   target/release/bundle/appimage/*.AppImage         <- portable bundle
#   target/release/bundle/deb/*.deb                   <- Debian package
set -euo pipefail
cd "$(dirname "$0")"
echo "Building Envy (release). This takes a few minutes the first time."
# linuxdeploy (the AppImage tool Tauri downloads) ships a 2018-era `strip` that
# chokes on the `.relr.dyn` sections modern Arch libraries carry
# ("unknown type [0x13] section") and aborts the whole bundle. NO_STRIP skips
# that step; the AppImage is a little larger and otherwise identical.
export NO_STRIP="${NO_STRIP:-true}"

if [ "${ENVY_SKIP_GATE:-0}" = "1" ]; then
  echo "ENVY_SKIP_GATE=1 — skipping the pre-ship gate."
else
  ./scripts/ship-check.sh --no-gui \
    || { echo "gate failed — fix it or ENVY_SKIP_GATE=1 to override"; exit 1; }
fi

npm run tauri build -- "$@"
echo
echo "Done. Standalone app: $(pwd)/target/release/envynote"
