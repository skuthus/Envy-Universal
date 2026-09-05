#!/usr/bin/env bash
# Summon Envy: show it if hidden, hide it if showing — the bar icon's click,
# on a key. `envynote --toggle` talks to the running instance over its
# control socket; with none running it simply launches, and the window
# appears.
#
# Which binary: ENVY_BIN if set; else a release build sitting in this
# checkout (the script lives in linux/ of the repo); else `envynote` on
# PATH, which is where a package puts it.
#
# Backgrounded and detached: when nothing is running the binary *becomes*
# the app, and a keybind (or a shell) must not sit waiting on it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${ENVY_BIN:-}"
if [ -z "$bin" ]; then
  if [ -x "$here/../target/release/envynote" ]; then
    bin="$here/../target/release/envynote"
  else
    bin="$(command -v envynote || true)"
  fi
fi
if [ -z "$bin" ]; then
  echo "envy-summon: no envynote found (set ENVY_BIN or install the package)" >&2
  exit 1
fi
if command -v uwsm-app >/dev/null 2>&1; then
  uwsm-app -- "$bin" --toggle >/dev/null 2>&1 &
else
  setsid "$bin" --toggle >/dev/null 2>&1 &
fi
