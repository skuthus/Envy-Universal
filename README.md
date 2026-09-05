# Envy for Windows

A Windows port of [Envy-Linux](https://github.com/skuthus/Envy-Linux) — a flat-file, frictionless note-taking application. One search box, instant results, and notes stored as plain `.md` files.

This tree is a greenfield port of the Linux app (Tauri v2 + Rust `envy-core` + CodeMirror 6), not a merge with the older Envy-Windows 1.7-era codebase. Omarchy, Hyprland, and WebKitGTK integrations are gated out; the shell uses WebView2, a Win32 tray icon, and in-process global shortcuts.

Open source under the MIT license. The macOS original is at [envynote.app](https://envynote.app).

## Running it

Toolchain: Rust stable (`x86_64-pc-windows-msvc`), Node LTS, and MSVC C++ build tools + Windows SDK. WebView2 is bundled on Windows 11.

```
npm install
dev.cmd                 # hot-reloading dev build
build.cmd               # release binary + NSIS installer
```

Notes live in `%USERPROFILE%\Documents\Envy` by default, created on first launch with a welcome note. Settings → Change Location… points it at another folder. The chosen path is the `vault` key of `%APPDATA%\envy\config.md`.

**Summon.** `Ctrl+Alt+Enter` shows or hides Envy from any app (Tauri global shortcut). The tray eye does the same on left click; right click opens the app menu.

## Configuration

Same file shape as Linux: markdown with one ` ```toml ` fence. Missing keys mean defaults.

`%APPDATA%\envy\config.md` holds every setting. Theme files live in `%APPDATA%\envy\themes\`.

From the command line:

```
envynote config check
envynote config path
envynote theme list
```

## Structure

- `crates/envy-core` — the note model and store. No UI, no Tauri. `cargo test -p envy-core`.
- `src-tauri` — the Tauri v2 shell: windowing, tray, file dialogs, updater.
- `src` — the TypeScript frontend; live markdown styling is CodeMirror 6 decorations over a plain text buffer.

Linux-only modules (`hyprland.rs`, `omarchy.rs`, `control.rs`, `kindle_mtp.rs`, `tray_linux.rs`) stay in the tree behind `cfg(target_os = "linux")` and are not compiled here.

## License

MIT. See LICENSE.
