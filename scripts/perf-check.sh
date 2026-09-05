#!/usr/bin/env bash
# Performance regression gate.
#
# Runs the release benchmark against a cached 20,000-note vault and compares
# every number against scripts/perf-baseline.json. Fails if anything is more
# than 1.5x the baseline (with a 5 ms floor, so a sub-10 ms metric can't be
# failed by scheduler noise). --update-baseline rewrites the baseline instead.
#
# The vault is generated once and kept in the cache directory, because making
# it takes minutes. It is never a real Index: this script only ever touches
# the cache path below.
#
# The baseline records the machine it was measured on. On any other machine the
# timings are printed but not enforced — a ratio against someone else's CPU is
# not a regression, and a gate that cries wolf gets ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="${XDG_CACHE_HOME:-$HOME/.cache}/envy-bench/vault20k"
BASELINE="$ROOT/scripts/perf-baseline.json"
BENCH="$ROOT/target/release/examples/bench"
UPDATE=0
[ "${1:-}" = "--update-baseline" ] && UPDATE=1

# The baseline's "machine" field is "<uname -sm> / <n> cpu / <date>"; the date
# is when it was taken, so only the hardware half identifies the machine.
MACHINE_HW="$(uname -sm) / $(nproc) cpu"

if [ ! -d "$VAULT" ] || [ -z "$(ls -A "$VAULT" 2>/dev/null)" ]; then
  if ! command -v node >/dev/null; then
    echo "perf: SKIP - no cached vault at $VAULT and no node to generate one"
    exit 0
  fi
  echo "perf: generating the 20k benchmark vault (once, a few minutes) ..."
  rm -rf "$VAULT"
  mkdir -p "$(dirname "$VAULT")"
  node "$ROOT/scripts/gen-test-vault.mjs" "$VAULT" 20000 >/dev/null
fi
echo "perf: vault $VAULT"

cargo build --release --quiet -p envy-core --example bench
NOW="$("$BENCH" "$VAULT" --json)"

if [ "$UPDATE" = 1 ]; then
  MACHINE="$MACHINE_HW / $(date +%F)"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["machine"]=sys.argv[2]; \
print(json.dumps(d, indent=2))' "$NOW" "$MACHINE" > "$BASELINE"
  echo "perf: baseline rewritten ($MACHINE)"
  exit 0
fi

BASE_HW="$(python3 -c 'import json,sys
m = json.load(open(sys.argv[1])).get("machine", "")
print(m.rsplit(" / ", 1)[0] if m else "")' "$BASELINE")"

ENFORCE=1
if [ -n "$BASE_HW" ] && [ "$BASE_HW" != "$MACHINE_HW" ]; then
  echo "perf: baseline recorded on $BASE_HW, this is $MACHINE_HW - timings reported, not enforced"
  ENFORCE=0
fi

# A laptop on battery in the power-saver profile runs every benchmark 1.5-2x
# slower than the plugged-in baseline, search paths nobody touched included.
# Still a FAIL (the gate can't tell throttling from a regression), but say so,
# so the reader plugs in and reruns instead of hunting for a slowdown.
POWER_NOTE=""
if [ "$(cat /sys/class/power_supply/BAT*/status 2>/dev/null | head -1)" = "Discharging" ] ||
   [ "$(powerprofilesctl get 2>/dev/null)" = "power-saver" ]; then
  POWER_NOTE="on battery / power-saver profile"
fi

python3 - "$BASELINE" "$NOW" "$ENFORCE" "$POWER_NOTE" <<'PY'
import json, sys
base = json.load(open(sys.argv[1]))
now = json.loads(sys.argv[2])
enforce = sys.argv[3] == "1"
power_note = sys.argv[4]
# 1.5x is a real regression; +5 ms absolute keeps a 2 ms metric from failing
# on a 3 ms hiccup, which is noise, not a slowdown anyone would ever feel.
LIMIT, FLOOR = 1.5, 5.0
print(f"{'metric':<30}{'base':>12}{'now':>12}{'ratio':>8}  ")
bad = []
for k, b in base.items():
    if k == "machine":
        continue
    n = now.get(k)
    if n is None:
        bad.append(k)
        print(f"{k:<30}{b:>12.1f}{'MISSING':>12}{'':>8}  SLOW")
        continue
    r = n / b if b else 1.0
    ok = n <= b * LIMIT or (b < 10.0 and n <= b + FLOOR)
    if not ok:
        bad.append(k)
    print(f"{k:<30}{b:>12.1f}{n:>12.1f}{r:>8.2f}  {'OK' if ok else 'SLOW'}")
if bad and not enforce:
    print("perf: reported only (different machine) - " + ", ".join(bad))
else:
    print(f"perf: {'FAIL - ' + ', '.join(bad) if bad else 'PASS'}")
if bad and power_note:
    print(f"perf: machine is {power_note} - a uniform slowdown is the CPU governor, not the code; plug in and rerun before trusting this")
sys.exit(1 if bad and enforce else 0)
PY
