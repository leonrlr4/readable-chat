// Pure functions: measure width, rewrite markdown tables that are too wide into cards, and extract the summary and outline used when folding.

// The terminal transcript leaves a bullet and indent to the left of each reply; subtract them when measuring width.
const GUTTER = 4

// Replies longer than this many lines are folded.
export const FOLD_LINES = 40

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

function isWide(code: number): boolean {
  return WIDE_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

// Columns the terminal actually draws after stripping inline markdown markers (CJK characters count as 2).
export function displayWidth(cell: string): number {
  const plain = cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '')
  let width = 0
  for (const ch of plain) {
    width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  }
  return width
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const FENCE = /^\s*(```|~~~)/

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return body.split(/(?<!\\)\|/).map(cell => cell.trim())
}

// Minimum column width that avoids breaking words: the longest English word. CJK text can wrap between any two characters, so it counts as one character.
export function minWidth(cell: string): number {
  const tokens = cell.split(/\s+|(?<=[\u3000-\u9fff\uff00-\uffef])|(?=[\u3000-\u9fff\uff00-\uffef])/)
  return Math.max(0, ...tokens.map(displayWidth))
}

// A table drawn as a grid is `│ a │ b │`: each column's content plus 3, plus 1 for the leftmost border. measure picks which width each column uses.
function gridWidth(rows: readonly string[][], measure: (cell: string) => number): number {
  const columns = Math.max(...rows.map(row => row.length))
  let width = 1
  for (let i = 0; i < columns; i++) {
    width += 3 + Math.max(...rows.map(row => measure(row[i] ?? '')))
  }
  return width
}

export function tableWidth(rows: readonly string[][]): number {
  return gridWidth(rows, displayWidth)
}

// Following Codex and rich: switch to cards when the columns still don't fit after shrinking each to its longest word, or when there are more than 4 columns and cells would wrap;
// otherwise leaf wraps text inside the cells. Looking only at the widest content would turn 3-column tables of long sentences into cards too, so check the minimum width first.
export function shouldCardify(rows: readonly string[][], room: number): boolean {
  if (gridWidth(rows, minWidth) > room) return true
  const columns = Math.max(...rows.map(row => row.length))
  return columns > 4 && tableWidth(rows) > room
}

function toCards(header: readonly string[], body: readonly string[][]): string[] {
  const out: string[] = []
  body.forEach((row, index) => {
    const title = row[0] || `${index + 1}`
    out.push(`**${title}**`)
    header.slice(1).forEach((name, i) => {
      const value = row[i + 1]
      if (value) out.push(`- ${name || `欄 ${i + 2}`}：${value}`)
    })
    out.push('')
  })
  return out
}

// Rewrite tables that should become cards at transcript width `columns` into one card per row; leave everything else unchanged.
export function cardifyWideTables(text: string, columns: number): string {
  return cardifyTables(text, columns - GUTTER)
}

// room is the number of columns the table can actually use: tables that pass shouldCardify become cards; other tables and content inside code fences stay unchanged.
export function cardifyTables(text: string, room: number): string {
  const lines = text.split('\n')
  const out: string[] = []
  let isInFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) isInFence = !isInFence
    const isTableStart =
      !isInFence && line.includes('|') && SEPARATOR.test(lines[i + 1] ?? '')
    if (!isTableStart) {
      out.push(line)
      i++
      continue
    }
    let end = i + 2
    while ((lines[end] ?? '').includes('|') && (lines[end] ?? '').trim()) end++
    const header = splitRow(line)
    const body = lines.slice(i + 2, end).map(splitRow)
    if (shouldCardify([header, ...body], room)) {
      out.push(...toCards(header, body))
    } else {
      out.push(...lines.slice(i, end))
    }
    i = end
  }
  return out.join('\n')
}

export type Folded = { summary: string; outline: string[]; hiddenLines: number }

// Following FORMAT_RULES, the model opens its conclusion paragraph with this label ("**重點**", "key point").
const SUMMARY_LABEL = /^\s*\*\*重點\*\*[:：]/

// Heading with inline markdown markers stripped, used to match the line leaf draws.
export function plainTitle(title: string): string {
  return title.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`~]/g, '').trim()
}

// What remains when folded: the paragraph starting with "**重點**：" (the key-point label), or the first paragraph if there is none (at most 6 lines); plus # to ### headings outside code fences.
export function fold(text: string): Folded {
  const lines = text.split('\n')
  const labelled = lines.findIndex(line => SUMMARY_LABEL.test(line))
  const summary: string[] = []
  for (const line of lines.slice(Math.max(0, labelled))) {
    if (!line.trim()) {
      if (summary.length) break
      continue
    }
    if (FENCE.test(line) || line.includes('|') || summary.length >= 6) break
    summary.push(line)
  }
  return {
    summary: summary.join('\n'),
    outline: headings(text).slice(0, 8),
    hiddenLines: lines.length - summary.length,
  }
}

// # to ### headings outside code fences, in order of appearance.
export function headings(text: string): string[] {
  const out: string[] = []
  let isInFence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) isInFence = !isInFence
    const heading = !isInFence && /^#{1,3}\s+(.+)$/.exec(line)
    if (heading) out.push(plainTitle(heading[1] ?? ''))
  }
  return out
}

// Source of code blocks that leaf draws with a "┌─ language ┐ + line numbers" frame, in order of appearance.
// leaf draws mermaid and math blocks as diagrams without the line-number frame, so they are not counted.
const DRAWN_AS_PICTURE = /^(mermaid|latex|tex|math)$/i

export function codeBlocks(text: string): string[] {
  const out: string[] = []
  let current: string[] | null = null
  let isPicture = false
  for (const line of text.split('\n')) {
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fence && current === null) {
      current = []
      isPicture = DRAWN_AS_PICTURE.test(fence[2] ?? '')
    } else if (fence && current !== null) {
      if (!isPicture) out.push(current.join('\n'))
      current = null
    } else if (current !== null) {
      current.push(line)
    }
  }
  return out
}

export function lineCount(text: string): number {
  return text.split('\n').length
}

// Source of mermaid code blocks, in order of appearance; matches the "┌─ mermaid ┐" frame leaf draws.
export function mermaidBlocks(text: string): string[] {
  const out: string[] = []
  let current: string[] | null = null
  for (const line of text.split('\n')) {
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fence && current === null) current = /^mermaid$/i.test(fence[2] ?? '') ? [] : null
    else if (fence && current !== null) {
      out.push(current.join('\n'))
      current = null
    } else if (current !== null) current.push(line)
  }
  return out
}
