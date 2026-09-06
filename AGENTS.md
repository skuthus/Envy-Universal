# Agent instructions

This repository is Envy for **both Linux and Windows**, from one tree. It is not
a Linux app with a Windows port bolted on, nor the reverse: a change lands once
and ships to both.

1. Start from this tree, not from the older Envy-Windows 1.7 codebase and not from the macOS Swift app. The Mac repo is the *behavior oracle*.
2. Platform code is gated, never duplicated or deleted. Omarchy, Hyprland, WebKitGTK and Unix-socket summon stay behind `cfg(target_os = "linux")`; WebView2, the Win32 tray and `window-chrome.ts` behind `cfg(windows)` or a runtime check. Frontend styling hangs off `html.windows`.
3. `envy-core` behavior stays aligned across all three. Do not loosen `filename.rs`. Keep per-folder `.trash/`.
4. Keep Ctrl as the Command equivalent. Global shortcuts work in-process on Windows.
5. Config is `~/.config/envy/config.md` on Linux and `%APPDATA%\envy\config.md` on Windows. Schema is `config/schema.json` — one file, read by Rust, the frontend and `gen-skill-docs.mjs`, so it cannot carry a per-platform default. Platform differences in defaults belong in the runtime (see `resolveAppearance` in `src/theme.ts`).
6. Never change either app identifier. `app.envynote.linux` and `app.envynote.windows` key each platform's WebView store — pinned notes, the tray pin, split fractions — and moving one silently discards a user's state.
7. `src-tauri/tauri.conf.json` is the Linux config; `tauri.windows.conf.json` overlays it. Keep the base holding Linux values, so a build that misses the overlay falls back to the identity with users.

Before shipping: `./scripts/check.sh` and `./scripts/gui-smoke.sh` on Linux,
then `bash scripts/check.sh` (Git Bash, needs `jq`) and `scripts\gui-smoke.ps1`
on a real Windows machine. A change that only builds on the platform you happen
to be sitting at is not finished. Expect fewer tests on Windows — the symlink,
pacman-update and Hyprland/Omarchy/tray tests are `cfg`-gated out. That gap is
correct; do not assert an exact count.
