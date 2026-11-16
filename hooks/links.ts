// leaf's --inline output drops URLs: `[text](url)` renders as a `#` marker followed by underlined text.
// This module restores the URLs: it matches underlined text back to the source links in order of appearance, then marks URLs and file paths on screen as clickable hrefs.

import type { Line, Span } from './ansi'

const FENCE = /^\s*(```|~~~)/
const MD_LINK = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const URL = /\bhttps?:\/\/[^\s<>()\[\]`'"，。、；：（）]+[^\s<>()\[\]`'"，。、；：（）.,;:!?]/g
// At least one `/` and a file extension, or starts with `~/`, `./`, or `/`; a line number `:42` or `:42:7` stays in the displayed text and is not part of the href.
const PATH = /(?<![\w/.:-])(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]+(?=(?::\d+){0,2}(?![\w/]))/g

// Markdown links in the source outside code fences and inline code, in order of appearance.
export function sourceLinks(text: string): string[] {
  const hrefs: string[] = []
  let isInFence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) isInFence = !isInFence
    if (isInFence) continue
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(MD_LINK)) {
      if (match[1]) hrefs.push(match[1])
    }
  }
  return hrefs
}

export type Places = { cwd: string; home: string }

function absolutePath(path: string, places: Places): string {
  if (path.startsWith('/')) return path
  if (path.startsWith('~/')) return places.home + path.slice(1)
  return `${places.cwd}/${path.replace(/^\.\//, '')}`
}

// Within a segment that has no href, split out URLs and file paths, each with its own href.
function splitBare(span: Span, places: Places): Span[] {
  const hits: { at: number; end: number; href: string; file?: Span['file'] }[] = []
  for (const match of span.text.matchAll(URL)) {
    const at = match.index ?? 0
    hits.push({ at, end: at + match[0].length, href: match[0] })
  }
  for (const match of span.text.matchAll(PATH)) {
    const at = match.index ?? 0
    const end = at + match[0].length
    if (hits.some(hit => at < hit.end && end > hit.at)) continue
    const path = absolutePath(match[0], places)
    const line = /^:(\d+)/.exec(span.text.slice(end))?.[1]
    hits.push({
      at,
      end,
      href: 'file://' + encodeURI(path),
      file: line ? { path, line: Number(line) } : { path },
    })
  }
  if (hits.length === 0) return [span]
  hits.sort((a, b) => a.at - b.at)
  const out: Span[] = []
  let at = 0
  for (const hit of hits) {
    if (hit.at > at) out.push({ text: span.text.slice(at, hit.at), style: span.style })
    const piece: Span = { text: span.text.slice(hit.at, hit.end), style: span.style, href: hit.href }
    if (hit.file) piece.file = hit.file
    out.push(piece)
    at = hit.end
  }
  if (at < span.text.length) out.push({ text: span.text.slice(at), style: span.style })
  return out
}

// A link without a scheme, such as `[text](src/a.ts)`, is treated as a file.
function linked(span: Span, href: string, places: Places): Span {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { ...span, href }
  const path = absolutePath(decodeURI(href.replace(/#.*$/, '')), places)
  return { ...span, href: 'file://' + encodeURI(path), file: { path } }
}

export function linkify(lines: readonly Line[], text: string, places: Places): Line[] {
  const hrefs = sourceLinks(text)
  let next = 0
  let current: string | undefined

  return lines.map(line =>
    line.flatMap((span, i) => {
      const after = line[i + 1]
      // How leaf draws a link: a `#` marker immediately followed by underlined text; when the text wraps, the next line still starts underlined.
      // Only the text carries the href: where the terminal has no hyperlinks, Claude Code draws each Link's URL after
      // its text, and a linked marker put the URL there twice.
      if (span.text === '#' && after?.style.underline) {
        current = hrefs[next++]
        return [span]
      }
      if (current && span.style.underline) return [linked(span, current, places)]
      current = undefined
      return splitBare(span, places)
    }),
  )
}
