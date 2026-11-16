#!/usr/bin/env bash
# Generates a custom leaf theme from the current Omarchy theme and prints the
# extra leaf arguments on stdout, one per line.
#
# Success: prints `--theme` and the theme file's absolute path, exit 0.
# Failure: prints nothing, exits non-zero; the caller falls back to leaf's default theme.
#
# leaf's --theme treats a value containing `/` or ending in `.toml` as a file path
# (looks_like_theme_file in src/theme/resolution.rs), so the theme file lives in the
# cache and ~/.config/leaf/config.toml is never touched. leaf uses the file name
# (without extension) as the theme name.
#
# Color source matches the aurora mod: foot.ini first (the colors the terminal
# actually draws), colors.toml only if foot.ini is unreadable. Some themes disagree
# between the two (light colors.toml, dark foot.ini).
#
# Cache: the stamp records the color source's path, inode, mtime and size plus this
# script's mtime; if all match, print the arguments without regenerating.
# omarchy-theme-set removes the whole theme directory and moves a new one in on every
# switch, so inode and mtime always change.
set -euo pipefail

THEME_DIR="${OMARCHY_THEME_DIR:-$HOME/.local/state/omarchy/current/theme}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/readable-chat"
OUT="$CACHE_DIR/omarchy.toml"
STAMP="$CACHE_DIR/omarchy.stamp"

# Keep stdout empty on failure: the arguments are printed once, at the very end.
emit() { printf '%s\n%s\n' '--theme' "$OUT"; }

source_file=''
source_kind=''
if [[ -r $THEME_DIR/foot.ini ]]; then
  source_file="$THEME_DIR/foot.ini"
  source_kind='foot'
elif [[ -r $THEME_DIR/colors.toml ]]; then
  source_file="$THEME_DIR/colors.toml"
  source_kind='toml'
else
  exit 1
fi

self="${BASH_SOURCE[0]}"
stamp_now="$(stat -L -c '%n %i %y %s' -- "$source_file" "$self" 2>/dev/null)" || exit 1

if [[ -s $OUT && -r $STAMP ]] && [[ "$(<"$STAMP")" == "$stamp_now" ]]; then
  emit
  exit 0
fi

mkdir -p -- "$CACHE_DIR" 2>/dev/null || exit 1
tmp="$(mktemp "$CACHE_DIR/.omarchy.XXXXXX.toml" 2>/dev/null)" || exit 1
trap 'rm -f -- "$tmp"' EXIT

# Parsing and color math run in awk: bash has no floating point, and starting python
# is an order of magnitude slower than awk. awk exits 2 if background or foreground is missing.
if ! awk -v kind="$source_kind" -v src="$source_file" '
function hexval(h,   i, v, c) {
  v = 0
  h = tolower(h)
  for (i = 1; i <= length(h); i++) {
    c = index("0123456789abcdef", substr(h, i, 1))
    if (c == 0) return -1
    v = v * 16 + c - 1
  }
  return v
}
function norm(h) {
  gsub(/["#[:space:]]/, "", h)
  h = tolower(substr(h, 1, 6))
  if (h !~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/) return ""
  return h
}
function R(h) { return hexval(substr(h, 1, 2)) }
function G(h) { return hexval(substr(h, 3, 2)) }
function B(h) { return hexval(substr(h, 5, 2)) }
function hex2(v) { v = int(v + 0.5); if (v < 0) v = 0; if (v > 255) v = 255; return sprintf("%02x", v) }
# t=0 gives a, t=1 gives b.
function mix(a, b, t) {
  return hex2(R(a) + (R(b) - R(a)) * t) hex2(G(a) + (G(b) - G(a)) * t) hex2(B(a) + (B(b) - B(a)) * t)
}
function lin(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ^ 2.4 }
function lum(h) { return 0.2126 * lin(R(h)) + 0.7152 * lin(G(h)) + 0.0722 * lin(B(h)) }
function contrast(a, b,   x, y) { x = lum(a); y = lum(b); return x > y ? (x + 0.05) / (y + 0.05) : (y + 0.05) / (x + 0.05) }
function max3(a, b, c) { return a > b ? (a > c ? a : c) : (b > c ? b : c) }
function min3(a, b, c) { return a < b ? (a < c ? a : c) : (b < c ? b : c) }
function chroma(h) { return max3(R(h), G(h), B(h)) - min3(R(h), G(h), B(h)) }
function hue(h,   r, g, b, mx, d, x) {
  r = R(h) / 255; g = G(h) / 255; b = B(h) / 255
  mx = max3(r, g, b); d = mx - min3(r, g, b)
  if (d == 0) return -1
  if (mx == r) { x = (g - b) / d; x = x - 6 * int(x / 6) }
  else if (mx == g) x = (b - r) / d + 2
  else x = (r - g) / d + 4
  x = x * 60 + 360
  return x - 360 * int(x / 360)
}
function hdist(a, b,   d) { d = a - b; if (d < 0) d = -d; return d > 180 ? 360 - d : d }
# Pick the candidate whose hue is closest to target. Candidates must have chroma
# (max-min > 30; greens in low-saturation themes often sit around 35) and at least 3:1
# contrast against the background. Prefer colors no other role has taken; share only
# when the theme has few colors (the same color repeated).
function pick(target, fallback,   i, c, best, bd, d, pass) {
  for (pass = 0; pass < 2; pass++) {
    best = ""; bd = 999
    for (i = 1; i <= ncand; i++) {
      c = cand[i]
      if (pass == 0 && (c in used)) continue
      d = hdist(hue(c), target)
      if (d < bd) { bd = d; best = c }
    }
    # A hue more than 60 degrees away is a different color family; do not force it
    # (e.g. substituting yellow in a theme that has no green).
    if (best != "" && bd <= 60) { used[best] = 1; return best }
  }
  return fallback
}
function addcand(h) {
  if (h == "" || (h in seen)) return
  seen[h] = 1
  if (chroma(h) > 30 && contrast(h, bg) >= 3) cand[++ncand] = h
}
function kv(k, v) { printf "%s = \"#%s\"\n", k, v }

BEGIN { section = ""; ncand = 0 }

kind == "foot" {
  line = $0
  sub(/[#;].*$/, "", line)
  if (line ~ /^[[:space:]]*\[/) { section = line; gsub(/[][[:space:]]/, "", section); next }
  if (section != "colors" && section != "colors-dark") next
  if (index(line, "=") == 0) next
  key = line; sub(/=.*/, "", key); gsub(/[[:space:]]/, "", key)
  val = line; sub(/^[^=]*=/, "", val)
  val = norm(val)
  if (val == "") next
  if (key == "foreground") fg = val
  else if (key == "background") bg = val
  else if (key ~ /^regular[0-7]$/) col[substr(key, 8) + 0] = val
  else if (key ~ /^bright[0-7]$/) col[substr(key, 7) + 8] = val
  next
}

kind == "toml" {
  line = $0
  if (line !~ /^[[:space:]]*[A-Za-z0-9_]+[[:space:]]*=[[:space:]]*"#/) next
  key = line; sub(/=.*/, "", key); gsub(/[[:space:]]/, "", key)
  val = line; sub(/^[^=]*=/, "", val); sub(/"[^"]*$/, "", val)
  val = norm(val)
  if (val == "") next
  if (key == "foreground") fg = val
  else if (key == "background") bg = val
  else if (key == "accent") accent_hint = val
  else if (key ~ /^color([0-9]|1[0-5])$/) col[substr(key, 6) + 0] = val
  next
}

END {
  if (bg == "" || fg == "") exit 2

  # The accent the theme declares comes first, then regular colors 1-6, then bright colors 9-14.
  addcand(accent_hint)
  for (i = 1; i <= 6; i++) addcand(col[i])
  for (i = 9; i <= 14; i++) addcand(col[i])

  dark = lum(bg) < 0.25
  strong = fg
  if (col[15] != "" && contrast(col[15], bg) > contrast(strong, bg)) strong = col[15]

  # accent: the declared one if present, else the most saturated candidate, else the foreground if everything is gray.
  accent = ""
  if (accent_hint != "" && chroma(accent_hint) > 30 && contrast(accent_hint, bg) >= 3) accent = accent_hint
  if (accent == "") { bc = -1; for (i = 1; i <= ncand; i++) if (chroma(cand[i]) > bc) { bc = chroma(cand[i]); accent = cand[i] } }
  if (accent == "") accent = strong
  used[accent] = 1

  text    = mix(fg, bg, 0.08)
  soft    = mix(fg, bg, 0.25)
  muted   = mix(fg, bg, 0.45)
  border  = mix(fg, bg, 0.65)
  faint   = mix(fg, bg, 0.75)
  surface = mix(bg, fg, 0.08)

  blue    = pick(220, accent)
  yellow  = pick(45,  accent)
  green   = pick(120, blue)
  magenta = pick(300, accent)
  cyan    = pick(185, blue)
  orange  = pick(25,  yellow)
  red     = pick(0,   accent)

  print "# Generated by leaf-theme.sh from " src "; overwritten on theme change."
  print "base = \"" (dark ? "ocean" : "arctic") "\""
  print "syntax = \"" (dark ? "base16-ocean.dark" : "base16-ocean.light") "\""
  print ""
  print "[ui]"
  kv("content_bg", bg)
  kv("toc_bg", surface)
  kv("toc_border", border)
  kv("toc_accent", accent)
  kv("toc_active_bg", mix(bg, fg, 0.14))
  kv("toc_inactive_bg", surface)
  kv("toc_header_fg", muted)
  kv("toc_hover_fg", strong)
  kv("toc_primary_active", strong)
  kv("toc_primary_inactive", soft)
  kv("toc_secondary_text_active", text)
  kv("toc_secondary_text_inactive", muted)
  kv("toc_index_inactive", faint)
  kv("toc_secondary_inactive", faint)
  kv("scrollbar_hover", accent)
  kv("status_bg", surface)
  kv("status_separator", muted)
  kv("status_brand_fg", bg)
  kv("status_brand_bg", accent)
  kv("status_filename_fg", text)
  kv("status_filename_bg", mix(bg, fg, 0.14))
  kv("status_shortcut_fg", muted)
  kv("status_percent_fg", accent)
  kv("status_dot_fg", muted)
  print ""
  print "[markdown]"
  # Two colors carry the hierarchy, the way glamour, codex and gemini-cli do it: accent for H1/H2, the strongest text for H3
  # and table headers, soft text below that; list markers in muted. Orange inline code is the only other hue outside alerts.
  kv("text", text)
  kv("strong_text", strong)
  kv("heading_1", accent)
  kv("heading_2", accent)
  kv("heading_3", strong)
  kv("heading_4", soft)
  kv("heading_other", soft)
  kv("heading_underline", faint)
  kv("rule", faint)
  kv("table_header", strong)
  kv("table_cell", text)
  kv("table_border", border)
  kv("table_separator", faint)
  kv("code_frame", border)
  kv("code_gutter", border)
  kv("code_label", muted)
  kv("inline_code_fg", orange)
  kv("inline_code_bg", surface)
  kv("link_icon", blue)
  kv("link_text", blue)
  kv("link_hover", mix(blue, strong, 0.4))
  kv("blockquote_marker", muted)
  kv("blockquote_text", soft)
  kv("list_level_1", muted)
  kv("list_level_2", muted)
  kv("list_level_3", muted)
  kv("ordered_list", muted)
  kv("task_checked", green)
  kv("task_unchecked", muted)
  kv("mark_fg", strong)
  kv("mark_bg", mix(bg, yellow, 0.35))
  kv("search_highlight_bg", mix(bg, fg, 0.25))
  kv("search_match_bg", yellow)
  kv("latex_inline_fg", magenta)
  kv("latex_inline_bg", surface)
  kv("latex_block_fg", magenta)
  kv("mermaid_keyword", accent)
  kv("mermaid_arrow", blue)
  kv("mermaid_label", green)
  kv("mermaid_block_fg", text)
  kv("alert_note", blue)
  kv("alert_tip", green)
  kv("alert_important", magenta)
  kv("alert_warning", yellow)
  kv("alert_caution", red)
  kv("footnote_ref", blue)
  kv("footnote_text", soft)
}
' "$source_file" >"$tmp" 2>/dev/null; then
  exit 1
fi

# Have leaf load the file before it goes into the cache: leaf exits non-zero on a parse
# error or an invalid color value.
if ! printf '# t\n' | leaf --inline plain:20 --theme "$tmp" >/dev/null 2>&1; then
  exit 1
fi

mv -f -- "$tmp" "$OUT" || exit 1
trap - EXIT
printf '%s\n' "$stamp_now" >"$STAMP" 2>/dev/null || true
emit
