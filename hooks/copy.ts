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
    const line = raw.replace(/^(⏺ | {2})/, '').replace(/\s+$/, '')
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
