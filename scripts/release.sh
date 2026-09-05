#!/usr/bin/env bash
# Cut a release: gate, build, assemble the tarball the PKGBUILD installs from,
# check that the PKGBUILD really packages it, and publish a GitHub release.
#
#   scripts/release.sh            # everything, ending in `gh release create`
#   scripts/release.sh --dry-run  # everything except the upload
#
# After the versioned release, scripts/publish-repo.sh refreshes the pacman
# repository (the `repo` release) so `pacman -Syu` picks the version up.
#
# The version is Tauri's (src-tauri/tauri.conf.json); the tag is v<version>.
# Bump the version there and in linux/PKGBUILD (_tauriver) before running.
# The gate can be skipped with ENVY_SKIP_GATE=1, which build.sh honours.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

VERSION=$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
TAG="v$VERSION"
NAME="envynote-$VERSION"
OUT="target/release/dist"
TARBALL="$OUT/$NAME-x86_64.tar.gz"

if [ ! -f agents/skills/envy/SKILL.md ]; then
  echo "release: agents/skills/envy/SKILL.md is missing - the package installs it" >&2
  exit 1
fi
if ! grep -q "^_tauriver=$VERSION\$" linux/PKGBUILD; then
  echo "release: linux/PKGBUILD _tauriver does not match $VERSION - bump it first" >&2
  exit 1
fi
if [ "$DRY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "release: working tree is not clean" >&2
  exit 1
fi

echo "== build (through the ship gate)"
./build.sh

echo "== assemble $TARBALL"
rm -rf "$OUT/$NAME"
mkdir -p "$OUT/$NAME/icons"
cp target/release/envynote "$OUT/$NAME/"
cp linux/envy.desktop linux/hyprland-envy.lua linux/envy-summon.sh LICENSE README.md "$OUT/$NAME/"
cp src-tauri/welcome.md "$OUT/$NAME/Welcome to Envy.md"
# The agent skill, as the PKGBUILD installs it: /usr/share/envy/agents/skills/envy.
mkdir -p "$OUT/$NAME/agents/skills"
cp -r agents/skills/envy "$OUT/$NAME/agents/skills/"
cp src-tauri/icons/32x32.png "$OUT/$NAME/icons/32.png"
cp src-tauri/icons/128x128.png "$OUT/$NAME/icons/128.png"
cp src-tauri/icons/128x128@2x.png "$OUT/$NAME/icons/256.png"
cp src-tauri/icons/icon.png "$OUT/$NAME/icons/512.png"
tar -C "$OUT" -czf "$TARBALL" "$NAME"
(cd "$OUT" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256")
SHA=$(cut -d' ' -f1 "$TARBALL.sha256")

echo "== check the PKGBUILD packages this tarball"
if command -v makepkg >/dev/null; then
  PKGDIR=$(mktemp -d)
  cp linux/PKGBUILD "$PKGDIR/"
  TARBALL_ABS=$(realpath "$TARBALL")
  ( cd "$PKGDIR" && ENVY_LOCAL_TARBALL="$TARBALL_ABS" makepkg -f --skipchecksums --nodeps >/dev/null 2>"$PKGDIR/makepkg.log" ) \
    || { echo "release: makepkg failed - see $PKGDIR/makepkg.log" >&2; exit 1; }
  PKG=$(ls "$PKGDIR"/envynote-*.pkg.tar.* | head -1)
  # Listed to a file: under pipefail, `tar | grep -q` fails on the broken
  # pipe grep's early exit hands tar, even when the entry is present.
  tar -tf "$PKG" > "$PKGDIR/files.txt"
  grep -q '^usr/bin/envynote$' "$PKGDIR/files.txt" || { echo "release: package lacks usr/bin/envynote" >&2; exit 1; }
  grep -q '^usr/share/envy/agents/skills/envy/SKILL.md$' "$PKGDIR/files.txt" \
    || { echo "release: package lacks the envy agent skill" >&2; exit 1; }
  echo "   ok: $(basename "$PKG") ($(grep -c '^usr/' "$PKGDIR/files.txt") files under usr/)"
  cp "$PKG" "$OUT/"
  rm -rf "$PKGDIR"
else
  echo "   makepkg not installed; skipped"
fi

APPIMAGE=$(ls target/release/bundle/appimage/*.AppImage 2>/dev/null | head -1 || true)

echo
echo "release $TAG"
echo "  tarball  $TARBALL"
echo "  sha256   $SHA"
[ -n "$APPIMAGE" ] && echo "  appimage $APPIMAGE"
echo "  PKGBUILD: set sha256sums=('$SHA') for the AUR (kept as SKIP in the repo copy)"

if [ "$DRY" = 1 ]; then
  echo "dry run: not uploading"
  exit 0
fi

echo "== publish"
git tag -a "$TAG" -m "Envy $VERSION" 2>/dev/null || echo "   tag $TAG already exists"
git push origin "$TAG"
# Hand-written notes when linux/release-notes/<version>.md exists (the same
# text the in-app What's New and the website carry), else GitHub's commit list.
NOTES="linux/release-notes/$VERSION.md"
if [ -f "$NOTES" ]; then
  gh release create "$TAG" "$TARBALL" "$TARBALL.sha256" ${APPIMAGE:+"$APPIMAGE"} \
    --title "Envy $VERSION" --notes-file "$NOTES"
else
  gh release create "$TAG" "$TARBALL" "$TARBALL.sha256" ${APPIMAGE:+"$APPIMAGE"} \
    --title "Envy $VERSION" --generate-notes
fi
echo "published: $(gh release view "$TAG" --json url --jq .url)"

# The pacman repository points at this version from now on.
scripts/publish-repo.sh
