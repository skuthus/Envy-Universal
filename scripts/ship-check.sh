#!/usr/bin/env bash
# The pre-ship gate. One entry point; run it after any significant change and
# always before ./build.sh.
#
#   ./scripts/ship-check.sh            # everything (~5-10 min, needs the display)
#   ./scripts/ship-check.sh --quick    # check.sh --quick + the dev GUI smoke
#   ./scripts/ship-check.sh --no-gui   # headless: checks, perf, release build
#   ./scripts/ship-check.sh --help     # this header
#
# ./build.sh runs the --no-gui gate itself before bundling.
#
# What each step proves:
#   check         tests, types, frontend build, audits, security invariants
#   perf          search/index timings are still within scripts/perf-baseline.json
#   release-build the production bundle actually links (and produces the binary
#                 the two release GUI steps need)
#   gui-dev       the app runs and the vault round-trip works (save, watcher,
#                 templates, delete-to-trash)
#   gui-release   the same through the REAL CSP — the dev build uses devCsp, so
#                 this is the only step that can catch a CSP regression
#   gui-big       19k notes: paging does not blank the window or wedge search
#
# Each step's output goes to a log; only PASS/FAIL/SKIP and timings are printed.
# On a failure the log path and its last 15 lines are shown.
#
# Still needs a human (no Wayland click tool here): pin behaviour while paging,
# the sort header, and the pop-out / pinned-note windows.
set -euo pipefail
cd "$(dirname "$0")/.."

quick=0
gui=1
while (( $# )); do
  case "$1" in
    --quick)  quick=1; shift ;;
    --no-gui) gui=0; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/{/^set -euo/d;s/^# \?//;p}' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --quick, --no-gui, --help)"; exit 2 ;;
  esac
done

# Prerequisites. A fresh clone is missing node_modules, and every step after
# `check` would then fail with a confusing error instead of the real one.
[[ -d node_modules ]] || { echo "node_modules is missing — run: npm install"; exit 2; }
missing=()
for t in cargo npm jq; do command -v "$t" >/dev/null || missing+=("$t"); done
if (( gui )); then
  for t in hyprctl grim wtype; do command -v "$t" >/dev/null || missing+=("$t"); done
fi
if (( ${#missing[@]} )); then
  echo "missing required tool(s): ${missing[*]}"
  exit 2
fi
# Optional: their steps degrade to a skip or a warning, so say so and carry on.
optional=()
for t in cargo-audit magick; do command -v "$t" >/dev/null || optional+=("$t"); done
if (( ${#optional[@]} )); then
  echo "  note  ${optional[*]} not installed — the parts that use them skip, not fail"
fi

LOGDIR="${XDG_RUNTIME_DIR:-/tmp}/envy-ship"
mkdir -p "$LOGDIR"

# Safe to re-run: this script only ever kills what it started, and it will not
# start anything on top of an app the owner has open.
if (( gui )) && pgrep -x envynote >/dev/null; then
  echo "Envy is already running — close it first (this script will not kill a window it did not open)."
  exit 2
fi

NAMES=(); RESULTS=(); SECS=()
failed=0

record() { NAMES+=("$1"); RESULTS+=("$2"); SECS+=("$3"); }

run_step() { # run_step <name> <cmd...>
  local name="$1"; shift
  local log="$LOGDIR/$name.log" t0=$SECONDS rc=0
  "$@" >"$log" 2>&1 || rc=$?
  local dt=$(( SECONDS - t0 ))
  if (( rc == 0 )); then
    printf '  PASS  %-14s %4ds\n' "$name" "$dt"
    record "$name" PASS "$dt"
  else
    printf '  FAIL  %-14s %4ds  (rc %d)  %s\n' "$name" "$dt" "$rc" "$log"
    tail -15 "$log" | sed 's/^/        | /'
    record "$name" FAIL "$dt"
    failed=1
  fi
}

skip_step() { # skip_step <name> <reason>
  printf '  SKIP  %-14s    -  %s\n' "$1" "$2"
  record "$1" SKIP 0
}

echo "== ship-check ($( (( quick )) && echo quick || echo full )$( (( gui )) || echo ", no-gui" )) — logs in $LOGDIR"

# 1. everything that needs no display
if (( quick )); then
  run_step check ./scripts/check.sh --quick
else
  run_step check ./scripts/check.sh
fi

# 2. performance against the recorded baseline
if (( quick )); then
  skip_step perf "--quick"
elif [[ -x ./scripts/perf-check.sh ]]; then
  run_step perf ./scripts/perf-check.sh
elif [[ -e ./scripts/perf-check.sh ]]; then
  skip_step perf "scripts/perf-check.sh is not executable"
else
  skip_step perf "scripts/perf-check.sh does not exist yet"
fi

# 3. the real release build — the dev-configured `cargo build --release` binary
#    loads the Vite URL and comes up blank, so it proves nothing.
if (( quick )); then
  skip_step release-build "--quick"
else
  run_step release-build npm run tauri build -- --no-bundle
fi

# 4-6. the display-driven steps
if (( ! gui )); then
  skip_step gui-dev "--no-gui"
  skip_step gui-release "--no-gui"
  skip_step gui-big "--no-gui"
else
  run_step gui-dev ./scripts/gui-smoke.sh

  if (( quick )); then
    skip_step gui-release "--quick"
    skip_step gui-big "--quick"
  else
    run_step gui-release ./scripts/gui-smoke.sh --release

    BIGVAULT="${ENVY_BIG_VAULT:-$HOME/.cache/envy-bench/vault20k}"
    if [[ -d "$BIGVAULT" ]]; then
      run_step gui-big ./scripts/gui-smoke.sh --release --big-vault "$BIGVAULT"
    else
      skip_step gui-big "no big vault at $BIGVAULT (set ENVY_BIG_VAULT to point at one)"
    fi
  fi
fi

echo
printf '  %-14s %-6s %5s\n' step result sec
printf '  %-14s %-6s %5s\n' -------------- ------ -----
for i in "${!NAMES[@]}"; do
  printf '  %-14s %-6s %5s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${SECS[$i]}"
done

if (( failed )); then
  echo
  echo "SHIP-CHECK FAILED — read the log named above, not this summary."
  exit 1
fi
echo
echo "SHIP-CHECK PASSED. Still needs a human: pin while paging, the sort header, pop-out/pinned windows."
