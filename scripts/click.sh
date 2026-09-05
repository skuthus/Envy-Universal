#!/usr/bin/env bash
# click.sh X Y [button] — move the real pointer to logical screen X,Y and click.
# Needs the ydotool user service (systemctl --user enable --now ydotool, with
# /dev/uinput readable by the user). Moves are relative with a feedback loop
# against `hyprctl cursorpos`, so libinput acceleration cannot throw them off.
# Button codes: 0xC0 left click, 0xC1 right click.
set -euo pipefail
tx=$1; ty=$2; btn=${3:-0xC0}
for _ in $(seq 1 20); do
  read -r cx cy < <(hyprctl cursorpos | tr -d ',')
  dx=$((tx-cx)); dy=$((ty-cy))
  (( dx==0 && dy==0 )) && break
  ydotool mousemove -x "$dx" -y "$dy"; sleep 0.12
done
read -r cx cy < <(hyprctl cursorpos | tr -d ',')
echo "at $cx,$cy (wanted $tx,$ty)"
ydotool click "$btn"
