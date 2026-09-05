---
name: run-envy
description: Launch and drive Envy (Tauri/WebKitGTK, Hyprland) to see a change working — dev build, window screenshots, keyboard-driven smoke test, and what still needs a human.
---

# Running Envy on the owner's machine (Omarchy / Hyprland / Wayland)

## Fast path

```bash
./scripts/check.sh --quick     # tests, tsc, build, config invariants (no display)
./scripts/gui-smoke.sh         # launches the app, drives it, checks the vault, screenshots
```

For the **full pre-ship gate** — the above plus perf, a real release build, and
the smoke run again through the production CSP and a 19k-note vault — use
`./scripts/ship-check.sh` instead (see the `ship-check` skill). This skill is
for looking at a change while you work on it; ship-check is for deciding it is
done.

`gui-smoke.sh` refuses to run unless the Index is a folder whose path contains
"Test Vault" (make one with `node scripts/gen-test-vault.mjs`, then Settings →
Change Location). It prints PASS/FAIL and leaves screenshots + `dev.log` in
`$XDG_RUNTIME_DIR/envy-smoke/dev/` (one subdirectory per mode). Read
`2-table-and-image.png`: the word "good"
must be underlined, "bad" must be plain text, the image must show.

## Release binary

`cargo build --release` inside `src-tauri/` produces a binary that still tries
to load the Vite dev URL, and with no dev server up the navigation guard
refuses it, so the window comes up blank. Build the real thing with
`npm run tauri build -- --no-bundle` (about 40 s) and run
`./target/release/envynote`. `./build.sh` is the same plus .deb/AppImage.
`./scripts/gui-smoke.sh --release` drives that binary (and refuses if it is
older than `src/` or `src-tauri/src/`); `--big-vault [path]` points the Index at
a large vault for a paging pass and always restores it afterwards.
The release build has its own localStorage origin, so settings such as list
previews differ from the dev build until you set them there too.

## Doing it by hand

- Launch: `nohup npm run tauri dev > dev.log 2>&1 &` — first Rust build takes
  a few minutes; later ones ~5s. The window class is `envynote`.
- Wait/locate: `hyprctl clients -j | jq '.[]|select(.class=="envynote")|{at,size}'`
- Focus: `hyprctl dispatch 'hl.dsp.focus({window="class:envynote"})'` — this
  Hyprland takes Lua, not the classic `focuswindow class:x` form, and prints a
  warning instead of failing; confirm with `hyprctl activewindow -j | jq .class`.
- Screenshot: `grim -g "X,Y WxH" shot.png` with the numbers from `at`/`size`,
  then Read the PNG and look at it.
- Don't send more than ~20 keys/s: the app opens a note on every arrow press
  (~35 ms each at 19k notes) and faster input queues up, so a screenshot taken
  right after shows the highlight still moving. Ctrl+Alt+P collides with
  fcitx5's toggle-preedit binding, so pin cannot be tested from the keyboard.
- Type: `wtype "text"`, keys `wtype -k Return`, chords `wtype -M ctrl l -m ctrl`.
  Search box: Ctrl+L; clear it: Alt+Backspace; Return opens the top match or
  creates the note and focuses the editor. `template:Name` + Return opens a
  template for editing. Ctrl+Backspace deletes the open note (to `.trash`).
- Don't type markdown tables through wtype — the editor auto-inserts pipes and
  the table comes out doubled. Write the `.md` file straight into the vault;
  the watcher reloads it within ~2s.
- Stop: `pkill -x envynote`, then kill the `npm run tauri dev` job (it is the parent of the CLI, vite and cargo).

## Testing config edits

Settings and themes are files, so most of the settings surface can be driven
without touching the GUI. With the app running, edit
`~/.config/envy/config.md` (only inside the ` ```toml ` fence) and watch the
window re-apply within a moment; the watcher is debounced at ~150 ms. Same for
`~/.config/envy/themes/*.md`.

```bash
envynote config path                       # where the file is
envynote config check                      # parse + validate; exit 1 with the problems
envynote theme list                        # theme files Envy can parse
envynote theme export smoke                # save the live theme as themes/smoke.md
```

`config check` needs no running instance, so it is also the fastest way to
prove a schema change from a terminal. `theme export` and `config edit` go
over the control socket and fail when Envy is not running.

Back up the real config before a destructive test
(`cp ~/.config/envy/config.md{,.bak}`), and delete the whole
`~/.config/envy/` directory to re-test first-launch creation and the
migration from the old `~/.config/app.envynote.linux/` files. The dev and
release builds share these files, unlike localStorage, so a setting checked in
one is already set in the other.

## Clicking

`./scripts/click.sh X Y` clicks at logical screen coordinates (right-click:
`click.sh X Y 0xC1`). It needs the ydotool user service running
(`systemctl --user is-active ydotool`; the owner set it up on Sep 1 2026). To
aim: screenshot the window with grim, note the pixel in the PNG, divide by the
monitor scale (2 on this machine), add the window's `at` offset. Verify a
click landed by typing a marker with wtype and reading the note file. Widgets
that need a mouse — pop-out (right-click a note → Pop Out), the pinned window,
the sort header, table toolbar, URL-pill menu — are all reachable this way.

## Bar icon (StatusNotifierItem + Omarchy bar widget)

Envy registers its own StatusNotifierItem (`src-tauri/src/tray.rs`, via
`ksni`) and installs a bar widget plugin (`linux/omarchy-plugin`) on first
launch. Both can be driven without a mouse:

- Bus name: `org.kde.StatusNotifierItem-<pid>-1`, object `/StatusNotifierItem`.
  `busctl --user get-property <bus> /StatusNotifierItem org.kde.StatusNotifierItem IconName`
  reads the eye (`envy-open|squint|closed-symbolic`);
  `... call <bus> /StatusNotifierItem org.kde.StatusNotifierItem Activate ii 0 0`
  is a left click.
- Menu: `busctl --user call <bus> /MenuBar com.canonical.dbusmenu GetLayout iias -- 0 -1 0`
  lists ids (`(ia{sv}av) <id> <n> "label" s "New Pinned Note"`); trigger one
  with `... Event isvu -- <id> clicked s "" 0`. Focus Envy first
  (`hl.dsp.focus`) before "New Pinned Note", or the popover hides itself on
  blur before you can see it.
- Scratchpad: `hyprctl dispatch 'hl.dsp.window.move({workspace="special:envy", follow=false, window="title:^Envy$"})'`
  parks the main window (eye closes); `hl.dsp.workspace.toggle_special('envy')`
  shows/hides it. Move back with `workspace="1"`.
- The widget lives at `~/.config/omarchy/plugins/skuthus.envy/`; first-run
  state is the marker `~/.config/app.envynote.linux/omarchy-bar` (delete it and
  restore `shell.json` to re-test the install). `omarchy-plugin-validate <dir>`
  checks the manifest. Back up `~/.config/omarchy/shell.json` before a
  first-run test.
- ydotool's `/dev/uinput` ACL does not survive the device node being
  recreated; if `ydotool` says the daemon isn't running, the owner has to
  re-run `sudo setfacl -m u:skuthus:rw /dev/uinput` and restart the unit.
