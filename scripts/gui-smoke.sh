#!/usr/bin/env bash
# Drive the real app under Hyprland and check what lands on disk.
#
# Launches the app, then — through the window, as a user would — creates a
# note, edits it, opens and edits a template, and deletes the note. Each step
# is verified by what appears in the vault, not by what the script typed, so it
# exercises save, the template read/save path, the file watcher, the
# table/link/image renderer (see the screenshots) and delete-to-trash.
#
#   ./scripts/gui-smoke.sh [output-dir]              # dev build (npm run tauri dev)
#   ./scripts/gui-smoke.sh --release [output-dir]    # ./target/release/envynote
#   ./scripts/gui-smoke.sh --release --big-vault [path]   # paging pass, 19k notes
#
# --release is the only way to exercise the production CSP: the dev build uses
# devCsp, and `cargo build --release` alone still points at the Vite URL.
# Build it with `npm run tauri build -- --no-bundle` (~40 s).
#
# The app under test never sees the owner's Index or config: it runs with
# XDG_CONFIG_HOME pointed at a copy of ~/.config/envy whose `vault` is the
# test vault ($ENVY_SMOKE_VAULT, else ~/Envy Test Vault; make one with
# scripts/gen-test-vault.mjs). Every other setting is the owner's, so the run
# looks like their Envy. --big-vault points that copy at a large vault
# instead (default $ENVY_BIG_VAULT, else ~/.cache/envy-bench/vault20k) and
# runs a paging pass instead of the write test — it never writes into it.
#
# Needs: hyprctl, grim, wtype, jq (magick/convert optional, for the blank
# check). It writes into the test vault, so it refuses to run unless that
# path contains "Test Vault" or ENVY_SMOKE_ALLOW=1.
# Not covered (no Wayland click tool): the pinned-note and pop-out windows —
# check those by hand: right-click a note → Pop Out; Ctrl+Alt+T pins to tray.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="dev"
BIG=0
BIGVAULT="${ENVY_BIG_VAULT:-}"
OUT=""
while (( $# )); do
  case "$1" in
    --release)   MODE="release"; shift ;;
    --big-vault) BIG=1
                 if [[ -n "${2:-}" && "${2:0:2}" != "--" ]]; then BIGVAULT="$2"; shift; fi
                 shift ;;
    -h|--help)   sed -n '2,28p' "$0"; exit 0 ;;
    --*)         echo "unknown option: $1"; exit 2 ;;
    *)           OUT="$1"; shift ;;
  esac
done

OUT="${OUT:-${XDG_RUNTIME_DIR:-/tmp}/envy-smoke}"
SUB="$MODE"; (( BIG )) && SUB="$MODE-big"
SHOT="$OUT/$SUB"
mkdir -p "$SHOT"
LOG="$SHOT/dev.log"
for t in hyprctl grim wtype jq; do
  command -v "$t" >/dev/null || { echo "need $t"; exit 2; }
done

# The owner's config, copied so the app under test can be pointed elsewhere
# without their file ever changing. Only `vault` is rewritten; the file's
# other settings, and their themes, come along as they are.
OWNER_CFG="${XDG_CONFIG_HOME:-$HOME/.config}/envy"
[[ -f "$OWNER_CFG/config.md" ]] || { echo "no Envy config at $OWNER_CFG/config.md - launch Envy once first"; exit 2; }
XDG="$SHOT/xdg"
rm -rf "$XDG"
mkdir -p "$XDG/envy"
[[ -d "$OWNER_CFG/themes" ]] && cp -r "$OWNER_CFG/themes" "$XDG/envy/"

if (( BIG )); then
  [[ -n "$BIGVAULT" ]] || BIGVAULT="$HOME/.cache/envy-bench/vault20k"
  [[ -d "$BIGVAULT" ]] || { echo "no big vault at '$BIGVAULT' (pass a path or set ENVY_BIG_VAULT)"; exit 2; }
  VAULT="$BIGVAULT"
  echo "== big-vault mode: the app under test opens $VAULT ($(ls "$VAULT" | wc -l) entries)"
else
  VAULT="${ENVY_SMOKE_VAULT:-$HOME/Envy Test Vault}"
  [[ -d "$VAULT" ]] || { echo "no test vault at '$VAULT' - make one: node scripts/gen-test-vault.mjs"; exit 2; }
  if [[ "$VAULT" != *"Test Vault"* && "${ENVY_SMOKE_ALLOW:-}" != 1 ]]; then
    echo "'$VAULT' is not a test vault (its path lacks \"Test Vault\"). Use one from"
    echo "scripts/gen-test-vault.mjs, or set ENVY_SMOKE_ALLOW=1 to run against it anyway."
    exit 2
  fi
fi
# `vault = "..."` is the first line of the TOML block; everything else is kept.
awk -v v="$VAULT" '
  /^vault = / && !done { print "vault = \"" v "\""; done = 1; next }
  { print }
' "$OWNER_CFG/config.md" >"$XDG/envy/config.md"
grep -q "^vault = \"$VAULT\"" "$XDG/envy/config.md" || { echo "could not point the copied config at $VAULT"; exit 2; }
export XDG_CONFIG_HOME="$XDG"

if [[ "$MODE" == "release" ]]; then
  BIN="./target/release/envynote"
  [[ -x "$BIN" ]] || { echo "no release binary at $BIN — build it: npm run tauri build -- --no-bundle"; exit 2; }
  stale="$(find src src-tauri/src -type f -newer "$BIN" -print -quit 2>/dev/null || true)"
  [[ -z "$stale" ]] || {
    echo "$BIN is older than $stale — rebuild: npm run tauri build -- --no-bundle"; exit 2; }
fi

TITLE="Smoke Test Note"
NOTE="$VAULT/$TITLE.md"
TEMPLATE=""
IMAGE=""
if (( ! BIG )); then
  TEMPLATE="$(ls "$VAULT"/Templates/*.md 2>/dev/null | head -1 || true)"
  for f in "$VAULT"/Attachments/*.png; do [[ -e "$f" ]] && IMAGE="$(basename "$f")" && break; done
fi
MARK="smoke-$(date +%s)"
fails=0
pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; fails=$((fails+1)); }

DEVPID=""
cleanup() {
  # The dev server is started in its own session, so its process group holds
  # npm, the tauri CLI, vite, cargo and the app — one signal takes them all.
  [[ -n "$DEVPID" ]] && kill -TERM -- "-$DEVPID" 2>/dev/null || true
  pkill -x envynote 2>/dev/null || true
  if (( ! BIG )); then
    [[ -n "$TEMPLATE" && -f "$SHOT/template.bak" ]] && cp "$SHOT/template.bak" "$TEMPLATE"
    rm -f "$NOTE" "$VAULT/.trash/$TITLE.md"
  fi
  true
}
trap cleanup EXIT

pgrep -x envynote >/dev/null && { echo "Envy is already running; close it first"; exit 2; }
if [[ "$MODE" == "dev" ]] && ss -ltn | grep -q ':1420 '; then
  echo "port 1420 is busy — a stale vite from an earlier run? try: pkill -f node_modules/.bin/vite"; exit 2
fi
(( BIG )) || rm -f "$NOTE" "$VAULT/.trash/$TITLE.md"

if [[ "$MODE" == "dev" ]]; then
  echo "== launching dev build (log: $LOG)"
  setsid npm run tauri dev >"$LOG" 2>&1 &
else
  echo "== launching release binary (log: $LOG)"
  setsid ./target/release/envynote >"$LOG" 2>&1 &
fi
DEVPID=$!
for _ in $(seq 1 90); do
  hyprctl clients -j | jq -e '.[] | select(.class=="envynote")' >/dev/null 2>&1 && break
  grep -q 'terminated with a non-zero status\|error\[E' "$LOG" 2>/dev/null && break
  sleep 2
done
GEO="$(hyprctl clients -j | jq -r '.[] | select(.class=="envynote") | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"' | head -1)"
[[ -n "$GEO" ]] || { echo "window never appeared — see $LOG"; exit 1; }
pass "window up at $GEO"

# Omarchy's Hyprland takes Lua dispatches and reports failure by message, not
# exit code, so focus is confirmed by asking which window is active.
focus() {
  for _ in 1 2 3 4 5; do
    hyprctl dispatch 'hl.dsp.focus({window="class:envynote"})' >/dev/null 2>&1 || true
    sleep 0.3
    [[ "$(hyprctl activewindow -j | jq -r .class)" == envynote ]] && return 0
    sleep 0.5
  done
  echo "could not focus the Envy window"; return 1
}
shot()  { grim -g "$GEO" "$SHOT/$1.png"; }
search() { wtype -k Escape; sleep 0.2; wtype -M alt -k BackSpace -m alt; sleep 0.2; wtype "$1"; sleep 0.8; wtype -k Return; sleep 1.2; }
# Return here is a newline when the editor has focus, and "open the
# highlighted row, then focus the editor" when the search box has it (as it
# does after an arrow press). The second is asynchronous, and the unoptimised
# dev build over a few thousand notes needs a moment before the text may
# follow, or it lands in the search box and reaches no file at all.
append_line() { wtype -M ctrl -k End -m ctrl; wtype -k Return; sleep 1.2; wtype "$1"; sleep 3; }

# Keystroke helpers for the big-vault pass: the app opens a note on every arrow
# press, so anything faster than ~15 keys/s queues up and the screenshot lags
# the input by seconds.
KEY_DELAY=0.07
tap()  { wtype -k "$1"; sleep "$KEY_DELAY"; }
type_slow() {
  local s="$1" i
  for (( i = 0; i < ${#s}; i++ )); do wtype "${s:i:1}"; sleep "$KEY_DELAY"; done
}

focus; shot 1-launch

if (( BIG )); then
  echo "== paging pass: 400 arrow-downs through $VAULT"
  wtype -k Escape; sleep 0.3
  wtype -M alt -k BackSpace -m alt; sleep 0.5
  for _ in $(seq 1 400); do tap Down; done
  # The highlight keeps moving after the last key, so wait for the window to
  # stop changing rather than guessing a sleep.
  settled=0
  grim -g "$GEO" "$SHOT/settle-a.png"
  for _ in $(seq 1 30); do
    sleep 1
    grim -g "$GEO" "$SHOT/settle-b.png"
    if cmp -s "$SHOT/settle-a.png" "$SHOT/settle-b.png"; then settled=1; break; fi
    mv "$SHOT/settle-b.png" "$SHOT/settle-a.png"
  done
  cp "$SHOT/settle-a.png" "$SHOT/2-paged.png"
  rm -f "$SHOT/settle-a.png" "$SHOT/settle-b.png"
  (( settled )) && pass "window settled after 400 arrow-downs" \
                || fail "window still repainting 30s after the last key"

  # A blank/white window is the failure this pass is really looking for, and
  # "not blank" is measurable: a real note list has plenty of pixel variance.
  MAGICK=""
  command -v magick >/dev/null && MAGICK="magick"
  [[ -z "$MAGICK" ]] && command -v convert >/dev/null && MAGICK="convert"
  if [[ -n "$MAGICK" ]]; then
    sd="$("$MAGICK" "$SHOT/2-paged.png" -colorspace Gray -format '%[fx:standard_deviation]' info: 2>/dev/null || echo 0)"
    if awk -v v="$sd" 'BEGIN{exit !(v > 0.02)}'; then
      pass "screenshot is not blank (stddev $sd)"
    else
      fail "screenshot looks blank (stddev $sd) — see $SHOT/2-paged.png"
    fi
  else
    echo "  skip blank check (no magick/convert) — look at $SHOT/2-paged.png yourself"
  fi

  echo "== search still works after paging"
  wtype -k Escape; sleep 0.5
  type_slow "note"; sleep 1.5; shot 3-search
  wtype -M alt -k BackSpace -m alt; sleep 1.0; shot 4-cleared
  pass "Escape / type / Alt+Backspace survived (see 3-search.png, 4-cleared.png)"
else
  echo "== note written on disk is picked up by the watcher and renders"
  {
    printf '# %s\n\n| Link | Kind |\n| --- | --- |\n' "$TITLE"
    printf '| [good](https://example.com) | must be a live link |\n'
    printf '| [bad](https:evil.com) | must stay plain text |\n'
    printf '| **bold** and `code` | formatting |\n\nProse link: https://envynote.app\n'
    [[ -n "$IMAGE" ]] && printf '\n![[%s]]\n' "$IMAGE"
  } >"$NOTE"
  sleep 3; focus; search "$TITLE"; shot 2-table-and-image
  pass "note opened — rendering is checked by eye in 2-table-and-image.png"

  echo "== typing in the editor saves to disk"
  append_line "$MARK-note"
  grep -q "$MARK-note" "$NOTE" && pass "edit saved" || fail "edit did not reach $NOTE"

  echo "== arrow keys move the highlight and open the next row (and it stays there)"
  # A second note, written after the first was edited, so with the list sorted
  # newest-first it is row 1 and the original is row 2. Return opens row 1;
  # Down from the search box must move to row 2, open it, and leave the
  # highlight there — a re-run of the search from anywhere (a settings loop, a
  # watcher misfire) snaps the highlight back to row 1 and the marker lands in
  # the second note instead.
  NOTE2="$VAULT/$TITLE 2.md"
  printf '# %s 2\n\nSecond note for the arrow check.\n' "$TITLE" >"$NOTE2"
  sleep 3; focus; search "$TITLE"
  wtype -k Escape; sleep 0.3; tap Down; sleep 1.5; shot 2b-arrow-down
  append_line "$MARK-arrow"
  if grep -q "$MARK-arrow" "$NOTE" && ! grep -q "$MARK-arrow" "$NOTE2"; then
    pass "Down opened the second row and the edit landed there"
  else
    fail "Down did not open the second row (marker in: $(grep -l "$MARK-arrow" "$NOTE" "$NOTE2" 2>/dev/null | tr '\n' ' '))"
  fi
  rm -f "$NOTE2"

  if [[ -n "$TEMPLATE" ]]; then
    echo "== template opens and saves through the validated template path"
    cp "$TEMPLATE" "$SHOT/template.bak"
    tname="$(basename "$TEMPLATE" .md)"
    focus; search "template:$tname"; append_line "$MARK-template"; shot 3-template
    grep -q "$MARK-template" "$TEMPLATE" && pass "template saved" || fail "template edit did not reach $TEMPLATE"
    cp "$SHOT/template.bak" "$TEMPLATE"
  else
    echo "  skip no templates in $VAULT/Templates"
  fi

  echo "== delete moves the note into the vault's .trash"
  focus; search "$TITLE"; wtype -M ctrl -k BackSpace -m ctrl; sleep 2.5; shot 4-after-delete
  [[ ! -e "$NOTE" && -e "$VAULT/.trash/$TITLE.md" ]] && pass "moved to .trash" || fail "note not in .trash"
fi

echo "== app log"
if grep -iE 'panic|Refused to|Content Security Policy|error' "$LOG" | grep -v appindicator | grep -q .; then
  fail "log has errors:"; grep -iE 'panic|Refused|Content Security|error' "$LOG" | grep -v appindicator | head -5
else
  pass "no errors"
fi

echo
if (( fails == 0 )); then
  if (( BIG )); then
    echo "PASS ($SUB) — screenshots in $SHOT"
  else
    echo "PASS ($SUB) — look at $SHOT/2-table-and-image.png: 'good' underlined, 'bad' plain, image visible."
  fi
else
  echo "FAIL ($fails) — screenshots and dev.log in $SHOT"; exit 1
fi
