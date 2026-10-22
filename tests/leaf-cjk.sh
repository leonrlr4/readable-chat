#!/usr/bin/env bash
# Pins how leaf renders a CJK table: every row must have the same display width and
# in-cell wraps must line up. Fails if a leaf upgrade changes the output; once the new
# output looks right, rewrite the snapshot with --update.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
actual=$(leaf --inline plain:40 "$here/snapshots/cjk-table.md")
if [[ ${1:-} == --update ]]; then
  printf '%s\n' "$actual" >"$here/snapshots/cjk-table.txt"
  exit 0
fi
widths=$(printf '%s\n' "$actual" | python3 -c "
import sys, unicodedata
for line in sys.stdin.read().splitlines():
    print(sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in line))
" | sort -u)
[[ $(wc -l <<<"$widths") == 1 ]] || { echo "table rows have different widths: $widths" >&2; exit 1; }
diff <(printf '%s\n' "$actual") "$here/snapshots/cjk-table.txt"
echo "leaf $(leaf --version | cut -d' ' -f2): CJK table snapshot matches"
