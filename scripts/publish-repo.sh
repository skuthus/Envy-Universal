#!/usr/bin/env bash
# Publish the pacman repository: one GitHub release, tagged `repo`, holding
# the current package and the database pacman reads. Users add
#
#   [envynote]
#   SigLevel = Optional TrustAll
#   Server = https://github.com/skuthus/Envy-Linux/releases/download/repo
#
# to /etc/pacman.conf once, install with `pacman -Sy envynote`, and
# `omarchy update` keeps Envy current from then on — the AUR experience
# without the AUR (whose registrations were closed when 1.0.0 shipped). release.sh runs this after the versioned release;
# it can also run alone against the package already in target/release/dist.
#
#   scripts/publish-repo.sh            # build the db, upload, replace old packages
#   scripts/publish-repo.sh --dry-run  # build the db locally and stop
#
# Only the current version is kept in the release: pacman wants the newest
# and nothing else, and old packages would pile up otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

REPO_NAME=envynote
TAG=repo
DIST=target/release/dist
VERSION=$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
PKGVER=${VERSION//-/}
PKG=$(ls "$DIST"/$REPO_NAME-"$PKGVER"-*-x86_64.pkg.tar.zst 2>/dev/null | sort -V | tail -1 || true)
if [ -z "$PKG" ]; then
  echo "publish-repo: no $REPO_NAME-$PKGVER package in $DIST - run scripts/release.sh first" >&2
  exit 1
fi

OUT="$DIST/repo"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$PKG" "$OUT/"
echo "== repo-add $(basename "$PKG")"
repo-add -q "$OUT/$REPO_NAME.db.tar.gz" "$OUT/$(basename "$PKG")"
# GitHub release assets are plain files, so the symlinks repo-add makes
# (envynote.db -> envynote.db.tar.gz) become copies under the names pacman
# requests.
for kind in db files; do
  rm -f "$OUT/$REPO_NAME.$kind"
  cp "$OUT/$REPO_NAME.$kind.tar.gz" "$OUT/$REPO_NAME.$kind"
done
echo "   $(tar -tzf "$OUT/$REPO_NAME.db" | grep -c '/desc$') package(s) in the database"

if [ "$DRY" = 1 ]; then
  echo "dry run: repository built in $OUT, not uploaded"
  exit 0
fi

echo "== publish to the '$TAG' release"
if ! gh release view "$TAG" >/dev/null 2>&1; then
  gh release create "$TAG" --title "Package repository" --latest=false --notes \
"A pacman repository, not a version. Add to /etc/pacman.conf:

    [$REPO_NAME]
    SigLevel = Optional TrustAll
    Server = https://github.com/skuthus/Envy-Linux/releases/download/$TAG

then \`sudo pacman -Sy $REPO_NAME\`; \`omarchy update\` (or \`pacman -Syu\` elsewhere) picks up new versions. The versioned releases carry the same package; this one only ever holds the newest."
fi
# Old packages go before the new database points at their replacement.
for old in $(gh release view "$TAG" --json assets --jq '.assets[].name' | grep "^$REPO_NAME-.*\.pkg\.tar\.zst$" || true); do
  [ "$old" = "$(basename "$PKG")" ] && continue
  gh release delete-asset "$TAG" "$old" --yes
  echo "   removed $old"
done
gh release upload "$TAG" --clobber \
  "$OUT/$(basename "$PKG")" "$OUT/$REPO_NAME.db" "$OUT/$REPO_NAME.db.tar.gz" \
  "$OUT/$REPO_NAME.files" "$OUT/$REPO_NAME.files.tar.gz"
echo "published: $(gh release view "$TAG" --json url --jq .url)"
