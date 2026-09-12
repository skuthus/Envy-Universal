# Envy

A flat-file, frictionless note-taking application. One search box, instant
results, and notes stored as plain `.md` files in a folder you choose, so the
notes outlive the app.

One codebase, two platforms: **Linux** (WebKitGTK) and **Windows** (WebView2),
sharing the same Rust `envy-core`, the same CodeMirror 6 frontend and the same
Tauri v2 shell. Platform code is gated, not forked — see
[Platform boundaries](#platform-boundaries).

Open source under the MIT license. The macOS original is a separate Swift app:
[skuthus/Envy](https://github.com/skuthus/Envy), [envynote.app](https://envynote.app).

## Installing a release

**Arch / Omarchy.** Envy ships from its own pacman repository (the AUR closed
registrations when 1.0.0 shipped), for x86_64 and aarch64 (Apple silicon
Macs running Asahi/Omarchy included). Add to `/etc/pacman.conf` once, with
the `Server` line for your machine (`uname -m` says which):

```
[envynote]
SigLevel = Optional TrustAll
Server = https://github.com/skuthus/Envy-Universal/releases/download/repo
```

or, on aarch64:

```
[envynote]
SigLevel = Optional TrustAll
Server = https://github.com/skuthus/Envy-Universal/releases/download/repo-aarch64
```

then `sudo pacman -Sy envynote`. Updates arrive with `omarchy update` (or a
plain `pacman -Syu` on other Arch systems; Omarchy's hook blocks that form).
Turn on Settings → System → "Bind Ctrl+Alt+Return in Hyprland", or add
`pcall(dofile, "/usr/share/envy/hyprland-envy.lua")` to
`~/.config/hypr/bindings.lua` yourself. Prefer building it? `cd linux &&
makepkg -si` from a clone.

> Installs made before the repository was renamed point at
> `.../skuthus/Envy-Linux/releases/download/repo`. GitHub redirects that
> permanently, so they keep working and need no edit.

**Other Linux.** Run the AppImage from the GitHub release (`amd64` for
x86_64, `aarch64` for ARM).

**Windows.** Run the NSIS installer from the GitHub release. WebView2 is
already present on Windows 11 and is fetched by the installer otherwise.

## Building it

Both platforms need Rust stable and Node LTS.

```bash
npm install

# Linux — also needs: webkit2gtk-4.1 gtk3 librsvg openssl
./dev.sh                    # hot-reloading dev build
./build.sh                  # pre-ship gate, then binary + .deb + AppImage
./linux/install-desktop.sh  # ~/.local/share/applications/envy.desktop
```

```
:: Windows — also needs MSVC C++ build tools + the Windows SDK
dev.cmd                     :: hot-reloading dev build
build.cmd                   :: release binary + NSIS installer
```

Notes live in `~/Documents/Envy` (Linux) or `%USERPROFILE%\Documents\Envy`
(Windows) by default, created on first launch with a welcome note. Settings →
Change Location… points it elsewhere; the chosen path is the `vault` key in the
config file below.

**Summon.** `Ctrl+Alt+Enter` shows or hides Envy from any app. The tray/bar eye
does the same on left click; right click opens the app menu. A floating Envy
comes back where you left it, at the size you left it, on every summon and at
the next launch, with nothing to configure: Envy keeps one window rule of its
own in Hyprland (`envy-place`) that says where the window maps, so it appears
in place rather than sliding there. A tiled Envy is the layout's to place.

## Checking it

```bash
./scripts/check.sh              # tests, tsc, build, config invariants — no display
./scripts/gui-smoke.sh          # Linux: drives the real window under Hyprland
.\scripts\gui-smoke.ps1         # Windows: the same run, driven through Win32
./scripts/ship-check.sh         # the full pre-release gate
```

`cargo test` reports more tests on Linux than on Windows. That is correct, not a
misconfiguration: the symlink, pacman-update and Hyprland/Omarchy/tray tests are
`cfg`-gated and do not exist on Windows.

## Configuration

The same file shape on both: markdown with one ` ```toml ` fence, and missing
keys mean defaults. Theme files sit beside it in `themes/`.

| | Config | Themes |
|---|---|---|
| Linux | `~/.config/envy/config.md` | `~/.config/envy/themes/` |
| Windows | `%APPDATA%\envy\config.md` | `%APPDATA%\envy\themes\` |

```
envynote config check
envynote config path
envynote theme list
```

**Appearance.** Both platforms default to the Envious dark face. On a machine
running Omarchy, Envy follows the current Omarchy theme
(`~/.local/state/omarchy/current/theme/colors.toml`) and its monospace font
instead — `omarchy theme set` or `omarchy font set` retints a running window.
Settings → Appearance pins Envious light/dark or a custom font. Where no
Omarchy font is available the default face is JetBrains Mono on Linux and
Cascadia Mono on Windows.

## Structure

- `crates/envy-core` — the note model and store. No UI, no Tauri. `cargo test -p envy-core`.
- `src-tauri` — the Tauri v2 shell: windowing, tray, file dialogs, updater.
- `src` — the TypeScript frontend; live markdown styling is CodeMirror 6
  decorations over a plain text buffer.

### Platform boundaries

Linux-only modules — `hyprland.rs`, `omarchy.rs`, `control.rs`, `kindle_mtp.rs`,
`tray_linux.rs` — sit behind `cfg(target_os = "linux")`. Windows-only ones —
`tray_windows.rs`, `boot_windows.rs`, `src/window-chrome.ts` — behind `cfg(windows)`
and a runtime check. Frontend platform styling hangs off `html.windows`.

Build configuration splits the same way: `src-tauri/tauri.conf.json` is the Linux
configuration, and `src-tauri/tauri.windows.conf.json` overlays it. The base file
holds the Linux values deliberately, so a build that somehow misses the overlay
falls back to the identity that has users rather than one that would strand them.

The two app identifiers are **not** interchangeable and must not be unified:
`app.envynote.linux` and `app.envynote.windows` key each platform's WebView
store, which holds pinned notes, the tray pin and the split fractions.

## License

MIT. See LICENSE.
