#!/usr/bin/env bash
# Installs MathJax 4 into the mod's cache so bin/math-to-svg.mjs can import it.
# Without it, hooks/math.ts returns null and replies keep leaf's Unicode approximation.
#
# The version is pinned: math-to-svg.mjs imports MathJax's internal module paths
# (js/adaptors/liteAdaptor.js and friends), which a major release can move.
# Rerunning is safe; npm leaves an existing matching install alone.
set -euo pipefail

VERSION="4.1.3"
DIR="${XDG_CACHE_HOME:-$HOME/.cache}/readable-chat/mathjax"

command -v npm >/dev/null || { echo "npm not found on PATH" >&2; exit 1; }
mkdir -p "$DIR"
# A package.json in DIR stops npm from walking up and installing into some parent project.
[ -f "$DIR/package.json" ] || printf '{ "private": true }\n' >"$DIR/package.json"
npm install --prefix "$DIR" --no-audit --no-fund --omit=dev "@mathjax/src@$VERSION"

# Smoke test: render one fraction through the same script the mod uses.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '%s' '\frac{a}{b}' | node "$ROOT/bin/math-to-svg.mjs" "$DIR" | grep -q '<svg' && echo "MathJax $VERSION installed in $DIR"
