#!/usr/bin/env bash
# Usage: open-in-nvim.sh <absolute-path> [line]
#
# Inside herdr: the first click splits a pane to the right of Claude's pane and
# runs nvim --listen there. Later clicks go to that same nvim (--server) and move
# focus to it.
# Outside herdr: hand off to omarchy-launch-editor, which opens a new terminal window;
# without Omarchy, run nvim in $TERMINAL, or xdg-open the file as a last resort.
set -euo pipefail

file=$1
line=${2:-}
plus=()
[[ -n $line ]] && plus=("+$line")

if [[ -z ${HERDR_PANE_ID:-} ]] || ! command -v herdr >/dev/null; then
  if command -v omarchy-launch-editor >/dev/null; then
    exec omarchy-launch-editor "${plus[@]}" "$file"
  elif [[ -n ${TERMINAL:-} ]] && command -v "$TERMINAL" >/dev/null; then
    setsid "$TERMINAL" -e nvim "${plus[@]}" "$file" >/dev/null 2>&1 &
    exit 0
  fi
  exec xdg-open "$file"
fi

# One nvim per Claude pane; the socket name is keyed by pane id.
key=${HERDR_PANE_ID//[^A-Za-z0-9]/_}
state=${XDG_RUNTIME_DIR:-/tmp}/readable-chat-$key
sock=$state.sock

if [[ -S $sock ]] && nvim --server "$sock" --remote-expr 1 >/dev/null 2>&1; then
  # :drop jumps to a window that already shows the file, otherwise opens it in the current window.
  target=$(printf '%q' "$file")
  nvim --server "$sock" --remote-send "<C-\\><C-N>:drop ${line:++$line }$target<CR>"
  herdr pane focus --pane "$HERDR_PANE_ID" --direction right >/dev/null 2>&1 || true
  exit 0
fi

rm -f "$sock"
# If nvim exited but its pane is still there (back at a shell), reuse it instead of splitting again.
pane=$(cat "$state.pane" 2>/dev/null || true)
if [[ -z $pane ]] || ! herdr pane get "$pane" >/dev/null 2>&1; then
  pane=$(herdr pane split --pane "$HERDR_PANE_ID" --direction right --cwd "$(dirname "$file")" --focus |
    sed -n 's/.*"pane_id" *: *"\([^"]*\)".*/\1/p' | head -n1)
  [[ -n $pane ]] || exit 1
  echo "$pane" >"$state.pane"
else
  herdr pane focus --pane "$HERDR_PANE_ID" --direction right >/dev/null 2>&1 || true
fi
herdr pane run "$pane" "$(printf '%q ' nvim --listen "$sock" "${plus[@]}" "$file")"
