#!/usr/bin/env bash
# Installs the .desktop entry and icon for the current user so launchers and
# the bar recognise Envy. Points at the release binary in this checkout; run
# ./build.sh first. Re-run after moving the checkout.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor"
mkdir -p "$apps" "$icons/128x128/apps" "$icons/256x256/apps" "$icons/512x512/apps"
sed "s|^Exec=.*|Exec=$repo/target/release/envynote|" "$here/envy.desktop" > "$apps/envy.desktop"
cp "$repo/src-tauri/icons/128x128.png" "$icons/128x128/apps/envy.png"
cp "$repo/src-tauri/icons/128x128@2x.png" "$icons/256x256/apps/envy.png"
cp "$repo/src-tauri/icons/icon.png" "$icons/512x512/apps/envy.png"
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q "$icons" 2>/dev/null || true
echo "Installed $apps/envy.desktop (Envy Omarchy) -> $repo/target/release/envynote"
