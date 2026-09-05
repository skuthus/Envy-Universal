---
name: ship-check
description: Run the full pre-ship gate for Envy before shipping a release — one script that covers tests, audits, security invariants, performance against the baseline, the real release build, and the GUI smoke on dev, release and a 19k-note vault. The owner's process is ideate → execute → user test → commit → gauntlet → push: the owner hand-checks during iteration, and this runs only when they say push (green gate, then push) or when they ask for a regression check.
---

# The pre-ship gate

```bash
./scripts/ship-check.sh            # everything (~5-10 min, needs the owner's display)
./scripts/ship-check.sh --quick    # while iterating: check.sh --quick + the dev GUI smoke
./scripts/ship-check.sh --no-gui   # headless: checks, perf, release build
```

Run the full gate before telling the owner a change is done; use `--quick`
between edits. `./build.sh` runs `ship-check.sh --no-gui` itself and refuses to
bundle if it fails (`ENVY_SKIP_GATE=1` overrides), so you do not have to run the
gate by hand first. `./scripts/check.sh --self-test` breaks each security
invariant in a throwaway copy of the tree and prints `bite`/`MISSED` per
mutation — run it when you touch `check.sh` itself, so a check that has quietly
stopped biting cannot keep reporting PASS.

## Reading the result

The script prints a summary table (step | result | seconds) and nothing else on
success. **Read only that table.** Every step's output is redirected to
`$XDG_RUNTIME_DIR/envy-ship/<step>.log`; on a failure the script already prints
the log path and its last 15 lines, which is normally enough to know what broke.

**Do not paste logs into the conversation.** If you need more than the 15 lines
shown, `grep` the log for the specific error and quote the one line that
matters. A build log is thousands of lines of cargo output and the owner does
not want to scroll it.

## What the steps mean

- `check` — tests, types, frontend build, audits, security invariants.
- `perf` — timings vs `scripts/perf-baseline.json`.
- `release-build` — `npm run tauri build -- --no-bundle`; also produces the
  binary the two release GUI steps drive.
- `gui-dev` — vault round-trip through the dev build.
- `gui-release` — the same through the production CSP. The dev build uses
  `devCsp`, so a CSP regression can only surface here.
- `gui-big` — 400 arrow-downs through a 19k-note vault, then search.

## When a step fails

- `perf` FAIL after a change you made **on purpose** (a new index field, a
  different sort): confirm the new numbers are reasonable, then re-record the
  baseline with `./scripts/perf-check.sh --update-baseline` and say in the
  commit body why the baseline moved. Never update the baseline to silence a
  slowdown you have not explained.
- `gui-*` FAIL: the screenshots are in `$XDG_RUNTIME_DIR/envy-smoke/<mode>/` —
  look at the PNG before guessing.
- `gui-*` SKIP or a refusal to start: Envy is already open (the script will not
  kill a window it did not open), the Index is not a "Test Vault", or there is
  no display. Say so; do not work around the guard.

## What it still cannot check

Pin behaviour while the list is paging, the sort header, and the pop-out and
pinned-note windows — all need a mouse click and there is no Wayland click tool
here. Ask the owner to check those by hand when they change.
