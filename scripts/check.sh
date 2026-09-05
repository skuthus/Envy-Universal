#!/usr/bin/env bash
# Pre-commit gate: everything that can be verified without a display.
# Run from anywhere; exits non-zero on the first failure.
#   ./scripts/check.sh            # tests, type-check, frontend build, audits
#   ./scripts/check.sh --quick    # skip the audits (they need the network)
#   ./scripts/check.sh --self-test  # prove the invariant checks still bite
#
# The whole pre-ship gate (this plus perf, a real release build and the GUI
# smoke) is ./scripts/ship-check.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

quick=0
selftest=0
case "${1:-}" in
  "")          ;;
  --quick)     quick=1 ;;
  --self-test) selftest=1 ;;
  *) echo "unknown option: $1 (try --quick, --self-test)"; exit 2 ;;
esac

# Tauri pins the GTK3 bindings, so their "unmaintained" advisories are expected
# noise; only a real vulnerability should block. Anything NOT in this list that
# shows up as unmaintained/unsound is printed as a warning at the end.
AUDIT_IGNORE=(
  RUSTSEC-2024-0411 RUSTSEC-2024-0412 RUSTSEC-2024-0413 RUSTSEC-2024-0414
  RUSTSEC-2024-0415 RUSTSEC-2024-0416 RUSTSEC-2024-0417 RUSTSEC-2024-0418
  RUSTSEC-2024-0419 RUSTSEC-2024-0420 RUSTSEC-2024-0429 RUSTSEC-2024-0370
  RUSTSEC-2024-0384 RUSTSEC-2025-0075 RUSTSEC-2025-0080 RUSTSEC-2025-0081
  RUSTSEC-2025-0098 RUSTSEC-2025-0100 RUSTSEC-2026-0221
)

# Every permission any capability file is allowed to ask for. Derived from the
# current src-tauri/capabilities/*.json — adding one here is a deliberate act,
# and the point is that widening the app's attack surface cannot happen by
# accident in a refactor. Read the capability's own description before adding.
ALLOWED_PERMS=(
  "core:default"
  "core:window:allow-center"
  "core:window:allow-close"
  "core:window:allow-hide"
  "core:window:allow-start-dragging"
  "dialog:allow-open"
  "opener:allow-default-urls"
  "opener:allow-open-url"
)

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { echo "$*"; exit 1; }

# run_invariants <root> — the security checks a refactor could quietly undo,
# run against any tree shaped like this repo. It is a subshell function, so
# `die` fails only this run: --self-test calls it once per deliberate mutation
# and every one of them has to come back non-zero.
run_invariants() (
  cd "$1"

  grep -q '"withGlobalTauri": false' src-tauri/tauri.conf.json || die "withGlobalTauri must stay false"
  grep -q '"csp": "default-src' src-tauri/tauri.conf.json || die "CSP is missing from tauri.conf.json"
  ! grep -Eq '^\s*"opener:default"' src-tauri/capabilities/*.json || die "capabilities should name opener permissions, not opener:default"
  grep -q 'navigation_guard' src-tauri/src/lib.rs || die "navigation guard plugin is gone"
  grep -q 'https?:\\/\\/\[^)\\s\]+' src/styler.ts || die "table link regex no longer requires //"
  ! grep -rn '__TAURI__\|innerHTML\s*=' src/ --include=*.ts | grep -v 'styler.ts' || die "new innerHTML/__TAURI__ use in src/ — review it"

  # The CSP is only real if nothing switches it off. dangerousDisableAssetCspModification
  # stops Tauri hashing the bundled assets into it; "csp": null removes it outright;
  # devtools in a release config ships an inspector with the app.
  ! grep -q 'dangerousDisableAssetCspModification' src-tauri/tauri.conf.json || die "dangerousDisableAssetCspModification must not appear in tauri.conf.json"
  ! grep -Eq '"csp"[[:space:]]*:[[:space:]]*null' src-tauri/tauri.conf.json || die '"csp": null disables the CSP'
  ! grep -Eq '"(devtools|openDevtools|debug)"[[:space:]]*:[[:space:]]*true' src-tauri/tauri.conf.json || die "devtools/debug flag enabled in tauri.conf.json"

  # Capabilities: no permission outside the allowlist at the top of this script.
  bad_perms="$(jq -r '.permissions[] | if type=="string" then . else .identifier end' \
    src-tauri/capabilities/*.json | sort -u | while read -r p; do
      case " ${ALLOWED_PERMS[*]} " in *" $p "*) ;; *) echo "$p";; esac
    done)"
  [[ -z "$bad_perms" ]] || die "capability permission not in ALLOWED_PERMS: $(echo $bad_perms) — widen the list on purpose or drop it"

  # Nothing in the frontend may build HTML or code from a string.
  ! grep -rnE '\beval\(|new Function|document\.write|insertAdjacentHTML|srcdoc|<iframe' src/ --include='*.ts' --include='*.html' --include='*.css' \
    || die "string-to-HTML/code construct added under src/ — review it"

  # A shell script without the strict flags fails open: a bad path or a typo
  # silently becomes a pass.
  for f in scripts/*.sh linux/*.sh; do
    [[ -e "$f" ]] || continue
    grep -q 'set -euo pipefail' "$f" || die "$f is missing 'set -euo pipefail'"
  done
)

# mutate <name> <root> — break exactly one invariant in a throwaway copy.
mutate() {
  local r="$2"
  case "$1" in
    csp-null)
      sed -i 's/"csp": "default-src[^"]*"/"csp": null/' "$r/src-tauri/tauri.conf.json" ;;
    with-global-tauri)
      sed -i 's/"withGlobalTauri": false/"withGlobalTauri": true/' "$r/src-tauri/tauri.conf.json" ;;
    extra-permission)
      sed -i 's/"core:default",/"core:default", "fs:default",/' "$r/src-tauri/capabilities/default.json" ;;
    opener-default)
      sed -i 's/^\( *\)"core:default",/\1"core:default",\n\1"opener:default",/' "$r/src-tauri/capabilities/default.json" ;;
    eval-in-ts)
      printf '\nconst _selftest = eval("1")\n' >> "$r/src/main.ts" ;;
    sh-missing-strict)
      sed -i '/^set -euo pipefail$/d' "$r/linux/envy-summon.sh" ;;
    table-regex-no-slashes)
      sed -i 's|https?:\\/\\/\[^)|https?:[^)|' "$r/src/styler.ts" ;;
    navigation-guard-gone)
      sed -i 's/navigation_guard/nav_guard_removed/g' "$r/src-tauri/src/lib.rs" ;;
    *) die "unknown mutation: $1" ;;
  esac
}

# --self-test: an invariant that has stopped biting is worse than no invariant,
# because the gate still says PASS. Copy the files the invariants read into a
# scratch tree (the real tree is never touched), break one thing at a time, and
# require a failure every time.
self_test() {
  local tmp pristine work m rc=0
  tmp="$(mktemp -d)"
  # expanded now: the EXIT trap runs after this function's locals are gone
  trap "rm -rf '$tmp'" EXIT
  pristine="$tmp/pristine"
  mkdir -p "$pristine/src-tauri/src" "$pristine/scripts" "$pristine/linux"
  cp -a src "$pristine/src"
  cp -a src-tauri/tauri.conf.json src-tauri/capabilities "$pristine/src-tauri/"
  cp -a src-tauri/src/lib.rs "$pristine/src-tauri/src/"
  cp -a scripts/*.sh "$pristine/scripts/"
  cp -a linux/*.sh "$pristine/linux/"

  # If the untouched copy already fails, every "bite" below would be a lie.
  if ! run_invariants "$pristine" >/dev/null 2>&1; then
    echo "self-test: the unmutated copy already fails the invariants:"
    run_invariants "$pristine" || true
    return 1
  fi

  for m in csp-null with-global-tauri extra-permission opener-default eval-in-ts \
           sh-missing-strict table-regex-no-slashes navigation-guard-gone; do
    work="$tmp/work"
    rm -rf "$work"
    cp -a "$pristine" "$work"
    mutate "$m" "$work"
    if run_invariants "$work" >/dev/null 2>&1; then
      printf 'MISSED %s\n' "$m"
      rc=1
    else
      printf 'bite   %s\n' "$m"
    fi
  done
  return "$rc"
}

if (( selftest )); then
  self_test || exit 1
  exit 0
fi

step "cargo test (envy-core + shell)"
cargo test --quiet 2>&1 | grep -E 'test result|error\[|panicked' || true
cargo test --quiet >/dev/null

step "TypeScript type-check"
npx tsc --noEmit

step "Agent skill docs match the schema and the shortcut table"
node scripts/gen-skill-docs.mjs --check \
  || die "agents/skills/envy is stale — run node scripts/gen-skill-docs.mjs and commit it"

step "Frontend build"
npm run build --silent

step "Rust build (shell)"
cargo build --quiet

if (( ! quick )); then
  step "cargo audit (vulnerabilities fail; unmaintained/unsound only warn)"
  if command -v cargo-audit >/dev/null; then
    ign=()
    for a in "${AUDIT_IGNORE[@]}"; do ign+=(--ignore "$a"); done
    cargo audit --deny warnings "${ign[@]}" \
      || die "cargo audit found something new — read the output above"
    # Unmaintained/unsound advisories outside the ignore list: worth knowing
    # about, not worth blocking a ship on.
    if command -v jq >/dev/null; then
      new_warn="$(cargo audit --json 2>/dev/null \
        | jq -r '[.warnings // {} | .[][] | .advisory.id] | unique[]?' 2>/dev/null || true)"
      for id in $new_warn; do
        case " ${AUDIT_IGNORE[*]} " in
          *" $id "*) ;;
          *) echo "  warn  new advisory $id (not in AUDIT_IGNORE — review, then add it or fix it)";;
        esac
      done
    fi
  else
    echo "cargo-audit not installed (cargo install cargo-audit --locked); skipping"
  fi

  step "npm audit (production deps only; dev-only advisories just warn)"
  npm audit --omit=dev --audit-level=high || exit 1
  npm audit --audit-level=high || echo "(dev-only advisory above — fix with npm audit fix when convenient)"
fi

step "Security invariants that a refactor could quietly undo"
run_invariants . || exit 1

printf '\n\033[1;32mAll checks passed.\033[0m\n'
