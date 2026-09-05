# Envy-Windows — greenfield port of Envy-Linux

Copy Envy-Linux. Replace Linux OS edges. Do not merge with the old Envy-Windows repo.

## Done

- Identity: `app.envynote.windows`, NSIS bundle, Windows README
- Linux modules gated: `hyprland`, `omarchy`, `control`, `kindle_mtp`, `tray_linux`
- Windows tray via Tauri (`tray_windows.rs`) with the eye icon and the Linux menu
- Kindle drive-letter detection; MTP (`gio`) skipped
- Fonts/theme defaults: system + Cascadia/Consolas, Omarchy/Hyprland settings hidden
- `dev.cmd` / `build.cmd`, single-instance plugin, CLI `config check|path` on Windows

## Still to verify on a machine with MSVC

- `cargo test -p envy-core`
- `npm run tauri dev` — search/create/save/wiki-link/trash against a real Index
- Tray left-click toggle, Keep on Top restack, Ctrl+Alt+Enter summon
- WebView2 pass (embeds, paste image, Settings, pop-outs)
- NSIS installer + updater pubkey (later; do not invent a signing key)
