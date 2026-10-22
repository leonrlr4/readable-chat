#!/usr/bin/env bash
# Omarchy theme-set hook: regenerates the leaf theme file when the theme changes.
#
# leaf-theme.sh already regenerates when the color source's mtime changes; this hook
# moves that work to the moment of the theme switch so the next reply doesn't wait on
# awk and the leaf check. omarchy-hook reports failures as "Hook failed", so this
# always exits 0 and never affects the theme switch.
set -euo pipefail

# Installed as a symlink, so resolve it to find leaf-theme.sh next to the real file.
script="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/leaf-theme.sh"
[[ -x $script ]] || exit 0
"$script" >/dev/null 2>&1 || true
exit 0
