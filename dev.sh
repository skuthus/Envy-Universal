#!/usr/bin/env bash
# Launch Envy in development mode: the frontend hot-reloads on save and the
# Rust side rebuilds automatically. This terminal is the app's parent process;
# closing it ends the session. Use build.sh for something that stands alone.
set -euo pipefail
cd "$(dirname "$0")"
echo "Starting Envy (dev)... Ctrl+C to stop."
exec npm run tauri dev -- "$@"
