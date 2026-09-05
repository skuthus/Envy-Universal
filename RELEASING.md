# Releasing Envy for Linux

The source is public (MIT). A release is a git tag, a GitHub release with
the assets, and a pacman repository that installs from them. (The AUR was
the plan, but it had closed new registrations when 1.0.0 shipped; the
PKGBUILD is ready for it whenever that changes.)

## What a release is

- **Tag** `v<version>`, where `<version>` is `src-tauri/tauri.conf.json`'s
  version (for example `1.0.0`). The Linux port has its own version line: it
  tracks the Mac app's features, not its number.
- **Tarball** `envynote-<version>-x86_64.tar.gz`: the release binary, the
  desktop entry, icons, the Hyprland bind file and its summon script, the
  `agents/skills/envy` skill, the welcome guide, the README and LICENSE. This is what the pacman
  package installs; `linux/PKGBUILD` copies exactly that tree into `/usr`, so
  the skill lands at `/usr/share/envy/agents/skills/envy` where Envy links it
  into `~/.claude/skills` and `~/.agents/skills` at launch.
- **AppImage**, for people not on Arch.
- **The `repo` release**: a pacman repository holding the newest package
  and its database (`envynote.db`, `envynote.files`), which is what
  `Server = https://github.com/skuthus/Envy-Linux/releases/download/repo`
  in a user's `pacman.conf` reads. `scripts/publish-repo.sh` refreshes it
  from the package `release.sh` built; only the current version is kept.

## Cutting one

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
   and `_tauriver` in `linux/PKGBUILD`. Write the notes three times over, in
   the same words: `linux/release-notes/<version>.md` (the GitHub release
   body), `WHATS_NEW` in `src/reference.ts` (the in-app What's New, shown
   once on the first launch of a new version), and the Omarchy section of
   the website's changelog. Update the version on the website's Omarchy
   page and the Linux badge on its front page. Commit.
2. `scripts/release.sh --dry-run` — runs the ship gate through `build.sh`,
   builds, assembles the tarball, and proves `linux/PKGBUILD` packages it
   with a local `makepkg`. Read what it prints.
3. `scripts/release.sh` — the same, then tags, pushes the tag, creates the
   GitHub release with `gh`, and refreshes the pacman repository
   (`scripts/publish-repo.sh`). Omarchy users then get the update through
   `omarchy update`.
4. If the AUR is open again: in an AUR checkout of `envynote`, update
   `_tauriver` and paste the sha256 the script printed into `sha256sums`,
   regenerate `.SRCINFO` (`makepkg --printsrcinfo > .SRCINFO`), commit, push.

The repo copy of `linux/PKGBUILD` keeps `sha256sums=('SKIP')` on purpose: it
is the template and the local-test harness, not the published package.

## Installing

- Omarchy / Arch: add the `[envynote]` repository from the README to
  `/etc/pacman.conf`, `sudo pacman -Sy envynote`, launch it, and turn on
  Settings → System → "Bind Ctrl+Alt+Return in Hyprland", which adds the
  `pcall(dofile, "/usr/share/envy/hyprland-envy.lua")` line to
  `~/.config/hypr/bindings.lua` and reloads Hyprland (or add it by hand).
  The bar widget installs itself on first launch.
- Anything else: download the AppImage from the release and run it.

## Updater

There is no in-app installer on Linux and no automatic check. Check Now (and
the tray's "Check for Updates…") asks GitHub's `releases/latest` for the
newest tag, compares it with the running version, and offers to open a
terminal with the update command — `sudo pacman -Sy envynote` for a package
install, a pull and `./build.sh` for a checkout. So every version must be a
real `vX.Y.Z` GitHub release (the `repo` release is published with
`--latest=false` so it is never mistaken for one), and the pacman repository
must be refreshed in the same step, which `release.sh` does.
