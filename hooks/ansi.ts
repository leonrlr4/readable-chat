// Parse the output of `leaf --inline ansi:<width>` into one list of styled segments per line, so the mod can draw them with Text.
// leaf emits only SGR (ESC[...m): 24-bit foreground/background color, bold, italic, underline, strikethrough, dim, reverse, and 0 for reset.

export type Style = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
}

// href and file are filled in by links.ts: segments with href render as links, and segments with file open in nvim when clicked.
export type Span = { text: string; style: Style; href?: string; file?: { path: string; line?: number } }
export type Line = Span[]

const SGR = /\x1b\[([0-9;]*)m/g

function hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')
}

// 256-color table: 0 to 15 map to the terminal's own ANSI color names; the rest convert to hex with the xterm formula.
const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
]

function color256(n: number): string {
  if (n < 16) return ANSI_NAMES[n] ?? 'white'
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return hex(v, v, v)
  }
  const i = n - 16
  const step = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return hex(step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6))
}

function apply(style: Style, params: number[]): Style {
  const next = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0
    if (p === 0) {
      for (const key of Object.keys(next)) delete next[key as keyof Style]
    } else if (p === 1) next.bold = true
    else if (p === 2) next.dimColor = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 9) next.strikethrough = true
    else if (p === 22) {
      delete next.bold
      delete next.dimColor
    } else if (p === 23) delete next.italic
    else if (p === 24) delete next.underline
    else if (p === 27) delete next.inverse
    else if (p === 29) delete next.strikethrough
    else if (p === 39) delete next.color
    else if (p === 49) delete next.backgroundColor
    else if (p >= 30 && p <= 37) next.color = ANSI_NAMES[p - 30]
    else if (p >= 90 && p <= 97) next.color = ANSI_NAMES[p - 90 + 8]
    else if (p >= 40 && p <= 47) next.backgroundColor = ANSI_NAMES[p - 40]
    else if (p >= 100 && p <= 107) next.backgroundColor = ANSI_NAMES[p - 100 + 8]
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'color' : 'backgroundColor'
      if (params[i + 1] === 2) {
        next[key] = hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0)
        i += 4
      } else if (params[i + 1] === 5) {
        next[key] = color256(params[i + 2] ?? 0)
        i += 2
      }
    }
  }
  return next
}

export function parseAnsi(output: string): Line[] {
  const lines: Line[] = []
  let style: Style = {}
  for (const raw of output.replace(/\n$/, '').split('\n')) {
    const line: Line = []
    let at = 0
    for (const match of raw.matchAll(SGR)) {
      const index = match.index ?? 0
      if (index > at) line.push({ text: raw.slice(at, index), style })
      const params = (match[1] || '0').split(';').map(Number)
      style = apply(style, params)
      at = index + match[0].length
    }
    if (at < raw.length) line.push({ text: raw.slice(at), style })
    lines.push(line)
  }
  return lines
}
