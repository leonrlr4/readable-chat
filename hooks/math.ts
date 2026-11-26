import type { EngineInterface, FsBytes } from 'claude-code'

import { CELL, base64ByteLength, decodeBase64Prefix, fitCells, pngSize } from './mermaid'

// Render display math that leaf's Unicode approximation cannot carry (fractions, matrices, aligned rows) to PNG for the Image component:
// MathJax 4 under node turns TeX into SVG (bin/math-to-svg.mjs), rsvg-convert turns that into PNG. Any failed step returns null,
// and the caller keeps leaf's `latex` frame. MathJax lives outside the mod (bin/install-mathjax.sh puts it in the cache), so a
// machine without it simply never gets math images.

// MermaidEngine's two calls plus the mod's folder, where math-to-svg.mjs lives; pass the hooks' $, and tests can substitute a fake.
export type MathEngine = {
  process: { run: EngineInterface['process']['run'] }
  fs: { read: (path: string, options: { as: 'bytes' }) => Promise<FsBytes> }
  plugin: { root: string }
}

export type MathImage = {
  // Used directly as Image props, like MermaidImage.
  source: { png: string }
  columns: number
  rows: number
  alt: string
}

export type MathOptions = {
  columns: number
  isDark: boolean
  maxRows: number
}

// The top line of every frame mathBlocks counts, matched against the row's trimmed text. leaf 1.29.1 labels $$...$$, ```latex and ```tex
// frames `latex`, a ```math frame `math`, and keeps the fence's own spelling otherwise (```LaTeX shows `LaTeX`, ```latex title shows
// `latex title`), hence case-insensitive. $$...$$ on a list item's first line gets the item's marker repeated on every frame row
// (`• ┌─ latex`, `◦ `, `▸ `, `☐ `, `12. `), so one short marker is allowed in front. A frame inside a blockquote starts with `▏ `
// and is not matched; mathBlocks skips quoted lines to stay in step.
export const MATH_FRAME = /^(?:(?!▏)\S{1,4} )?┌─ (?:latex|math|tex) /i

// leaf's code frames have a line-number gutter, so their bottom is `└─┴───┘`, unlike mermaid's `└────┘`; same optional list marker.
export const MATH_FRAME_BOTTOM = /^(?:(?!▏)\S{1,4} )?└─*┴─*┘$/

// Macros that leaf flattens badly: \frac{a+b}{c} becomes (a+b)/c, a matrix stays raw TeX, \\ rows run together. The lookahead keeps
// \over from matching \overline and \lim from matching \limits; \pmatrix and \cfrac are the same constructs under another name.
const COMPLEX = /\\(?:(?:[dtc]?frac|sqrt|sum|int|prod|lim(?:inf|sup)?|over|binom|[pbvBV]?matrix)(?![a-zA-Z])|begin\{)|\\\\/

// A ```latex fence often holds a document rather than a formula; MathJax would only fail on it, so skip the node run.
const DOCUMENT = /\\(?:documentclass|usepackage|begin\{document\}|section|chapter)(?![a-zA-Z])/

export function isComplexMath(tex: string): boolean {
  return COMPLEX.test(tex) && !DOCUMENT.test(tex)
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const MATH_LANG = /^(latex|math|tex)$/i
const QUOTE = /^\s*>/
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/
// CommonMark's block-level tags start an HTML block anywhere, even mid-paragraph; any other tag only at a paragraph's start.
const HTML_BLOCK_TAG =
  /^\s{0,3}<\/?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|main|menu|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?:[\s/>]|$)/i
const HTML_BLOCK_ANY = /^\s{0,3}<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>\s*$/
// A thematic break (---, ***, ___) or a setext underline (===, ---) ends the paragraph above it.
const BREAK = /^\s{0,3}(?:([-*_])(?:\s*\1){2,}|=+)\s*$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

// TeX of every `latex`/`math` frame leaf draws, in the order it draws them. Measured against leaf 1.29.1: fences whose first info word is
// latex, tex or math (any case); $$...$$ anywhere in a paragraph, list item or heading, including inline in a sentence and across lines
// of one paragraph, with several per line; nothing inside other fences, indented code, inline code, tables, HTML blocks or blockquotes,
// and nothing for an unclosed $$ or inline $...$. Pass the same text leaf was given (after cardifying tables), or the counts drift.
export function mathBlocks(markdown: string): string[] {
  const out: string[] = []
  const lines = markdown.split('\n')
  let fence: { marker: string; math: string[] | null } | null = null
  let paragraph: string[] = []
  // html: an HTML block, which only a blank line ends. lazy: a blockquote or table, whose following lines belong to it (lazy
  // continuation, table rows) until a blank line or a line that opens another block.
  let skip: 'html' | 'lazy' | null = null
  let isInIndentedCode = false
  let isInList = false

  const flush = () => {
    if (paragraph.length > 0) out.push(...displayMath(paragraph.join('\n')))
    paragraph = []
  }
  const openFence = (line: string) => {
    const open = FENCE.exec(line)
    // A backtick fence's info string cannot contain a backtick; ```x``` on one line is inline code.
    return open && !(open[1]?.startsWith('`') && open[2]?.includes('`')) ? open : null
  }
  const isHtmlStart = (line: string) => HTML_BLOCK_TAG.test(line) || (paragraph.length === 0 && HTML_BLOCK_ANY.test(line))
  const opensBlock = (line: string) => openFence(line) !== null || HEADING.test(line) || LIST_ITEM.test(line) || isHtmlStart(line)

  // leaf hides YAML front matter: a first line of --- up to the next ---, blank lines and all.
  const frontMatterEnd = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1

  for (let i = frontMatterEnd + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const blank = line.trim() === ''

    if (fence) {
      const close = FENCE.exec(line)
      const marker = close?.[1] ?? ''
      if (close && marker[0] === fence.marker[0] && marker.length >= fence.marker.length && (close[2] ?? '').trim() === '') {
        if (fence.math) out.push(fence.math.join('\n'))
        fence = null
      } else fence.math?.push(line)
      continue
    }

    if (blank) {
      flush()
      skip = null
      continue
    }

    if (skip === 'html') continue
    if (skip === 'lazy') {
      if (QUOTE.test(line) || !opensBlock(line)) continue
      skip = null
    }

    // Indented code cannot interrupt a paragraph, and inside a list four spaces is a continuation; it runs until text returns to the margin.
    const indent = /^( {4}|\t)/.test(line)
    if (isInIndentedCode && indent) continue
    isInIndentedCode = false
    if (indent && !isInList && paragraph.length === 0) {
      isInIndentedCode = true
      continue
    }
    // A line at the margin leaves the list, unless it lazily continues the item's paragraph.
    if (!/^\s/.test(line)) isInList = LIST_ITEM.test(line) || (isInList && paragraph.length > 0)
    else if (LIST_ITEM.test(line)) isInList = true

    if (QUOTE.test(line)) {
      flush()
      skip = 'lazy'
      isInList = false
      continue
    }

    const open = openFence(line)
    if (open) {
      flush()
      const lang = (open[2] ?? '').trim().split(/\s+/)[0] ?? ''
      fence = { marker: open[1] ?? '```', math: MATH_LANG.test(lang) ? [] : null }
      continue
    }

    if (isHtmlStart(line)) {
      flush()
      skip = 'html'
      isInList = false
      continue
    }
    if (BREAK.test(line)) {
      flush()
      isInList = false
      continue
    }
    // Inside a list item a table is lazy continuation text, so its cells' $$ are framed like any other.
    if (!isInList && line.includes('|') && TABLE_DELIMITER.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      flush()
      skip = 'lazy'
      continue
    }
    // A list item starts a block of its own; its continuation lines join it below.
    if (LIST_ITEM.test(line)) flush()
    if (HEADING.test(line)) {
      flush()
      out.push(...displayMath(line))
      continue
    }
    paragraph.push(line)
  }
  flush()
  // An unclosed fence runs to the end of the reply in leaf too, and leaf frames it.
  if (fence?.math) out.push(fence.math.join('\n'))
  return out
}

// $$...$$ pairs in one paragraph, scanned left to right the way leaf's parser does: whichever of a code span, $ or $$ opens first wins,
// so `$$x$$` is code but $$ `a` $$ is math. Matches leaf on these probes: `\$` is an escaped dollar inside and outside math
// ($$a \$ b$$ is framed, \$$a$$ is not), and a lone unescaped `$` inside cancels the pair ($$a $ b$$ stays text).
function displayMath(text: string): string[] {
  const found: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
    } else if (text[i] === '`') {
      i = afterCodeSpan(text, i)
    } else if (text.startsWith('$$', i)) {
      const end = closingDollars(text, i + 2)
      if (end < 0) {
        i += 2
        continue
      }
      found.push(text.slice(i + 2, end).trim())
      i = end + 2
    } else if (text[i] === '$') {
      i = afterInlineMath(text, i)
    } else i++
  }
  return found
}

// Inline $...$ is skipped whole, since it can take a dollar from a following $$ (\$$a$$ shows inline `a` and a stray $, no frame).
// It opens on a $ not followed by whitespace and closes on the next $ not preceded by whitespace; a $ after whitespace, as in
// "$5 and $$x$$", leaves the opener as a literal dollar.
function afterInlineMath(text: string, start: number): number {
  if (/\s/.test(text[start + 1] ?? ' ')) return start + 1
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$') return /\s/.test(text[i - 1] ?? ' ') ? start + 1 : i + 1
  }
  return start + 1
}

// Index of the closing $$, or -1 when there is none or a lone $ comes first.
function closingDollars(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text.startsWith('$$', i)) return i
    else if (text[i] === '$') return -1
  }
  return -1
}

// A code span opens with a run of n backticks and closes at the next run of exactly n; an unmatched run is literal text.
function afterCodeSpan(text: string, start: number): number {
  let n = 0
  while (text[start + n] === '`') n++
  for (let i = start + n; i < text.length; ) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let m = 0
    while (text[i + m] === '`') m++
    if (m === n) return i + m
    i += m
  }
  return start + n
}

// Same limits as mermaid: Image caps a bytes source at 2 MiB after decoding.
const MAX_PNG_BYTES = 2 * 1024 * 1024
const MAX_TEX = 4000

// Drawing at twice the box's CSS px lets kitty scale down, which keeps thin fraction bars and sub/superscripts sharp.
const RENDER_SCALE = 2

// MathJax start-up (node, font tables) takes 120 to 160 ms with the compile cache warm, about 400 ms cold; 3 s only stops a runaway formula.
const TEX_TIMEOUT_MS = 3000
const RSVG_TIMEOUT_MS = 2000

// Theme foregrounds for MathJax's currentColor; rsvg would otherwise paint it black, unreadable on a dark terminal.
const INK = { dark: '#e5e5e5', light: '#1f1f1f' }

const cache = new Map<string, Promise<MathImage | null>>()
const CACHE_LIMIT = 100

export function clearMathCache(): void {
  cache.clear()
  mathjaxDir = null
}

export function renderMath($: MathEngine, tex: string, options: MathOptions): Promise<MathImage | null> {
  const key = `${options.isDark ? 'dark' : 'light'}\n${Math.floor(options.columns)}\n${options.maxRows}\n${tex}`
  const hit = cache.get(key)
  if (hit) return hit
  const pending = render($, tex, options).catch(() => null)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '')
  cache.set(key, pending)
  return pending
}

// Where install-mathjax.sh put MathJax; same XDG rule as the script and leaf-theme.sh. Resolved once per module load.
let mathjaxDir: Promise<string | null> | null = null

export function findMathjax($: MathEngine): Promise<string | null> {
  mathjaxDir ??= $.process
    .run(['sh', '-c', 'printf %s "${XDG_CACHE_HOME:-$HOME/.cache}/readable-chat/mathjax"'], { timeoutMs: 1000 })
    .then(run => {
      const dir = run.stdout.trim()
      return run.exitCode === 0 && dir.startsWith('/') ? dir : null
    })
    .catch(() => null)
  return mathjaxDir
}

// <svg width="47.43px" height="37.41px" ...> as math-to-svg.mjs writes it.
export function svgSize(svg: string): { width: number; height: number } | null {
  const tag = /^<svg\b[^>]*>/.exec(svg)?.[0]
  if (!tag) return null
  const width = Number(/\swidth="([\d.]+)px"/.exec(tag)?.[1])
  const height = Number(/\sheight="([\d.]+)px"/.exec(tag)?.[1])
  return width > 0 && height > 0 ? { width, height } : null
}

// Recolor and resize to the box. The box is fitCells' rounding of the natural size, so its aspect ratio differs slightly;
// preserveAspectRatio centers the formula in it instead of stretching, and the PNG then matches the box Image scales it into.
export function prepareSvg(svg: string, pxWidth: number, pxHeight: number, isDark: boolean): string {
  const ink = isDark ? INK.dark : INK.light
  const sized = svg.replace(/^<svg\b[^>]*>/, tag =>
    tag
      .replace(/\swidth="[^"]*"/, ` width="${pxWidth}"`)
      .replace(/\sheight="[^"]*"/, ` height="${pxHeight}"`)
      .replace(/^<svg\b/, '<svg preserveAspectRatio="xMidYMid meet"'),
  )
  return sized.replaceAll('currentColor', ink)
}

// Alt text when the terminal cannot draw the image: the TeX itself on one line, which is what leaf would have shown.
export function mathAlt(tex: string): string {
  const flat = tex.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

async function render($: MathEngine, tex: string, options: MathOptions): Promise<MathImage | null> {
  const source = tex.trim()
  if (source === '' || source.length > MAX_TEX) return null
  const dir = await findMathjax($)
  if (!dir) return null

  const typeset = await $.process.run(['node', `${$.plugin.root}/bin/math-to-svg.mjs`, dir], {
    stdin: source,
    timeoutMs: TEX_TIMEOUT_MS,
  })
  if (typeset.exitCode !== 0 || typeset.isStdoutTruncated) return null
  const natural = svgSize(typeset.stdout)
  if (!natural) return null
  // fitCells rounds the natural size up to whole cells at most, so a formula is never drawn larger than MathJax set it; only a narrow pane or maxRows shrinks it.
  const box = fitCells(natural.width, natural.height, options.columns, options.maxRows)
  if (!box) return null
  const svg = prepareSvg(
    typeset.stdout,
    box.columns * CELL.width * RENDER_SCALE,
    box.rows * CELL.height * RENDER_SCALE,
    options.isDark,
  )

  // process.run decodes stdout as UTF-8, so the PNG goes through a temp file, as in mermaid.ts.
  const temp = await $.process.run(['mktemp', '--tmpdir', 'readable-chat-math-XXXXXX'], { timeoutMs: 1000 })
  const path = temp.stdout.trim()
  if (temp.exitCode !== 0 || !path.startsWith('/')) return null
  try {
    // No background flag: rsvg-convert leaves it transparent, so the formula sits on the terminal's own background.
    const drawn = await $.process.run(['rsvg-convert', '-f', 'png', '-o', path], { stdin: svg, timeoutMs: RSVG_TIMEOUT_MS })
    if (drawn.exitCode !== 0) return null
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    if (base64ByteLength(base64) > MAX_PNG_BYTES) return null
    if (!pngSize(decodeBase64Prefix(base64, 24))) return null
    return { source: { png: base64 }, columns: box.columns, rows: box.rows, alt: mathAlt(source) }
  } finally {
    await $.process.run(['rm', '-f', path], { timeoutMs: 1000 }).catch(() => null)
  }
}
