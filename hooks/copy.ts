// Turn a mouse selection of leaf's rendered output back into pasteable markdown:
// strip the transcript's `⏺ ` and two-column indent, heading underlines, table borders, and code block frames and line numbers,
// then rejoin paragraphs and table cells that leaf wrapped to fit the terminal width.

const RULE = /^[─═]+$/
const BORDER_ONLY = /^[┌┐└┘├┤┬┴┼─═╞╡╪\s]+$/
const CODE_TOP = /^┌─\s*([\w+-]*)\s*─*┐$/
const CODE_LINE = /^│\s*\d+│ ?(.*?)\s*│$/
const CODE_BOTTOM = /^└─+┴─*┘$/
const TABLE_ROW = /^│.*│$/
const LIST_ITEM = /^(\s*)(•|◦|▪|‣|-|\d+\.|\[[ x]\])\s+(.*)$/
const QUOTE = /^▏\s?(.*)$/
const CJK = /[　-鿿＀-￯]/

// At a wrap point, join directly if both sides are CJK characters; otherwise insert a space.
function join(left: string, right: string): string {
  if (left === '') return right
  const isTight = CJK.test(left.slice(-1)) || CJK.test(right.slice(0, 1))
  return isTight ? left + right : `${left} ${right}`
}

function cells(row: string): string[] {
  return row.slice(1, -1).split('│').map(cell => cell.trim())
}

export function cleanSelection(selected: string): string {
  const out: string[] = []
  let paragraph: string | null = null
  let table: string[][] = []
  let isNewRow = true
  let isInCode = false

  const flushParagraph = () => {
    if (paragraph !== null) out.push(paragraph)
    paragraph = null
  }
  const flushTable = () => {
    if (table.length === 0) return
    const width = Math.max(...table.map(row => row.length))
    table.forEach((row, i) => {
      out.push(`| ${Array.from({ length: width }, (_, j) => row[j] ?? '').join(' | ')} |`)
      if (i === 0) out.push(`|${' --- |'.repeat(width)}`)
    })
    table = []
    isNewRow = true
  }

  for (const raw of selected.split('\n')) {
    // A code block's 「⧉ 複製」 button sits at the right end of its top frame and comes along in a screen copy.
    const line = raw.replace(/^(⏺ | {2})/, '').replace(/\s*⧉ 複製\s*$/, '').replace(/\s+$/, '')
    const trimmed = line.trim()

    if (isInCode) {
      const code = CODE_LINE.exec(trimmed)
      if (code) out.push(code[1] ?? '')
      else if (CODE_BOTTOM.test(trimmed)) {
        out.push('```')
        isInCode = false
      }
      continue
    }
    const top = CODE_TOP.exec(trimmed)
    if (top) {
      flushParagraph()
      flushTable()
      out.push('```' + (top[1] === 'text' ? '' : (top[1] ?? '')))
      isInCode = true
      continue
    }
    if (trimmed !== '' && RULE.test(trimmed)) {
      // Heading underline: the previous line is a heading, so restore its markdown marker.
      if (paragraph !== null) {
        out.push(`${trimmed.startsWith('═') ? '#' : '##'} ${paragraph}`)
        paragraph = null
      }
      continue
    }
    if (trimmed !== '' && BORDER_ONLY.test(trimmed)) {
      flushParagraph()
      isNewRow = true
      continue
    }
    if (TABLE_ROW.test(trimmed)) {
      flushParagraph()
      const row = cells(trimmed)
      const last = table[table.length - 1]
      if (isNewRow || last === undefined) table.push(row)
      else row.forEach((cell, i) => (last[i] = join(last[i] ?? '', cell)))
      isNewRow = false
      continue
    }
    flushTable()
    if (trimmed === '') {
      flushParagraph()
      if (out[out.length - 1] !== '') out.push('')
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flushParagraph()
      const indent = (item[1] ?? '').length >= 2 || item[2] === '◦' ? '  ' : ''
      const marker = /^\d+\./.test(item[2] ?? '') ? item[2] : '-'
      paragraph = `${indent}${marker} ${item[3] ?? ''}`
      continue
    }
    const quote = QUOTE.exec(trimmed)
    if (quote) {
      flushParagraph()
      out.push(`> ${quote[1] ?? ''}`)
      continue
    }
    paragraph = paragraph === null ? trimmed : join(paragraph, trimmed)
  }
  flushParagraph()
  flushTable()
  if (isInCode) out.push('```')

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Letters and digits survive leaf's rendering; markup, borders, bullets and wrap points do not. Matching on them alone
// finds where a selection of the rendered reply came from in its markdown source.
const WORD = /[\p{L}\p{N}]/u
const EDGE = 16
const MARKUP = '*_~`'

type Words = { key: string; at: number[] }

function words(text: string): Words {
  let key = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    if (!WORD.test(char)) continue
    key += char
    at.push(i)
  }
  return { key, at }
}

// A selection is matched against up to 50 replies, on every poll while it is being dragged; each reply's words are worked
// out once instead of once per poll (about 1 ms for a 70 KB reply), and the selection's once per selection.
const WORDS_CACHE_SIZE = 60
const sourceWords = new Map<string, Words>()
let selectionWords: { selected: string; key: string } | undefined

function wordsOfSource(source: string): Words {
  const hit = sourceWords.get(source)
  if (hit) return hit
  const found = words(source)
  if (sourceWords.size >= WORDS_CACHE_SIZE) sourceWords.delete(sourceWords.keys().next().value ?? '')
  sourceWords.set(source, found)
  return found
}

function wordsOfSelection(selected: string): string {
  if (selectionWords?.selected !== selected) selectionWords = { selected, key: words(cleanSelection(selected)).key }
  return selectionWords.key
}

// The stretch of `source` the selected rendered text came from, so a copy keeps the backticks around `version_no` and the
// lines leaf only wrapped to fit the screen. A selection over several lines widens to whole source lines (a list marker or
// a code fence stays with its line); one inside a line widens only over markup touching its ends. Null when not found.
export function sourceSlice(selected: string, source: string): string | null {
  const wanted = wordsOfSelection(selected)
  if (wanted.length === 0) return null
  const { key, at } = wordsOfSource(source)

  let start = key.indexOf(wanted)
  let end = start + wanted.length
  if (start < 0) {
    // leaf adds text the source lacks (a link's URL, a table turned into cards), and a screen copy picks up what was
    // drawn over the reply (the sticky heading, on every row it sat on while the drag scrolled). So the two ends are
    // matched separately, each by the first EDGE letters near it that the source has.
    if (wanted.length < EDGE * 2) return null
    const reach = Math.floor(wanted.length / 3)
    // What was drawn over a row takes about as many letters as the text it hid, so an end found `offset` letters in
    // reaches back (or on) as far, to keep the rows the overlay covered.
    start = -1
    for (let offset = 0; start < 0 && offset + EDGE <= reach; offset += EDGE / 2) {
      const found = key.indexOf(wanted.slice(offset, offset + EDGE))
      if (found >= 0) start = Math.max(0, found - offset)
    }
    end = -1
    for (let offset = 0; start >= 0 && end < 0 && offset + EDGE <= reach; offset += EDGE / 2) {
      const found = key.indexOf(wanted.slice(wanted.length - offset - EDGE, wanted.length - offset), start)
      if (found >= 0) end = Math.min(key.length, found + EDGE + offset)
    }
    if (end < 0) return null
    if (end - start > wanted.length * 1.5 + 50) return null
  }

  let from = at[start] ?? 0
  let to = (at[end - 1] ?? 0) + 1
  if (source.slice(from, to).includes('\n')) {
    from = source.lastIndexOf('\n', from - 1) + 1
    const lineEnd = source.indexOf('\n', to)
    to = lineEnd < 0 ? source.length : lineEnd
    // A selection that starts or ends inside a code block takes the fence line on that side too.
    const before = source.slice(0, from)
    if ((before.match(/^```/gm)?.length ?? 0) % 2 === 1) from = before.lastIndexOf('```')
    if ((source.slice(0, to).match(/^```/gm)?.length ?? 0) % 2 === 1) {
      const close = source.indexOf('\n```', to)
      if (close >= 0) to = close + 4
    }
  } else {
    while (from > 0 && MARKUP.includes(source[from - 1] ?? '')) from--
    while (to < source.length && MARKUP.includes(source[to] ?? '')) to++
  }
  return source.slice(from, to).trim()
}
