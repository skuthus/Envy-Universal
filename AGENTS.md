# Agent instructions

This repository is the Windows port of Envy-Linux.

1. Start from this tree, not from the older Envy-Windows 1.7 codebase and not from the macOS Swift app. The Mac repo is the *behavior oracle*.
2. Do not reintroduce Omarchy, Hyprland, WebKitGTK, or Unix-socket summon. Those stay behind `cfg(target_os = "linux")`.
3. `envy-core` behavior stays aligned with Linux/Mac. Do not loosen `filename.rs`. Keep per-folder `.trash/`.
4. Keep Ctrl as the Command equivalent. Global shortcuts work in-process on Windows.
5. Config lives at `%APPDATA%\envy\config.md`. Schema is `config/schema.json`.

Before shipping: `cargo test -p envy-core`, then `build.cmd`.
