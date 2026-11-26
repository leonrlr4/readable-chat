import type { EngineInterface, FsBytes, ImageSource } from 'claude-code'

// Render mermaid code blocks to PNG with the local mmdr (cargo's mermaid-rs-renderer, pure Rust, no Chrome)
// for the Image component. Any failed step returns null, and the caller falls back to leaf's ASCII diagram.

// Only these two calls are used; pass the hooks' $, and tests can substitute a fake.
export type MermaidEngine = {
  process: { run: EngineInterface['process']['run'] }
  fs: { read: (path: string, options: { as: 'bytes' }) => Promise<FsBytes> }
}

export type MermaidImage = {
  // Used directly as Image props: <Image source={img.source} columns={img.columns} rows={img.rows} alt={img.alt} />
  source: ImageSource
  columns: number
  rows: number
  alt: string
  // Actual PNG pixel size, for debugging and tests.
  width: number
  height: number
}

export type MermaidOptions = {
  columns: number
  isDark: boolean
  maxRows?: number
}

export type CellSize = { width: number; height: number }

// Size of one terminal cell in mmdr pixels (CSS px). With kitty, JetBrainsMono 12pt, and 1.25 display scaling, a cell is about 12×26 physical pixels,
// or about 9.6×21 CSS px; getting the 2.2 aspect ratio right matters more than the exact width, since a wrong ratio squashes or stretches the image.
export const CELL: CellSize = { width: 10, height: 22 }

// Scale factor applied to the box's pixel size before rendering: drawing larger than the physical pixels lets kitty scale down, which keeps text sharp.
const RENDER_SCALE = 2

const DEFAULT_MAX_ROWS = 40

// Image caps columns and rows at 255; a bytes source can be at most 2 MiB after decoding.
const MAX_CELLS = 255
export const MAX_PNG_BYTES = 2 * 1024 * 1024

// While streaming, the same code arrives repeatedly; caching the Promise lets concurrent requests share one render.
const cache = new Map<string, Promise<MermaidImage | null>>()
const CACHE_LIMIT = 100

export function clearMermaidCache(): void {
  configPaths.clear()
  cache.clear()
}

// Choose the box size in cells from the image's natural pixel size and the available width, keeping the aspect ratio. If too tall, maxRows wins and the width shrinks to match.
export function fitCells(
  pxWidth: number,
  pxHeight: number,
  maxColumns: number,
  maxRows: number = DEFAULT_MAX_ROWS,
  cell: CellSize = CELL,
): { columns: number; rows: number } | null {
  if (!(pxWidth > 0 && pxHeight > 0 && maxColumns >= 1 && maxRows >= 1)) return null
  const columnLimit = Math.min(Math.floor(maxColumns), MAX_CELLS)
  const rowLimit = Math.min(Math.floor(maxRows), MAX_CELLS)
  const ratio = (pxHeight / pxWidth) * (cell.width / cell.height)
  let columns = Math.max(1, Math.min(columnLimit, Math.ceil(pxWidth / cell.width)))
  let rows = Math.max(1, Math.round(columns * ratio))
  if (rows > rowLimit) {
    rows = rowLimit
    columns = Math.max(1, Math.min(columnLimit, Math.round(rows / ratio)))
  }
  return { columns, rows }
}

// Read the PNG IHDR: 8-byte signature, 4-byte length, "IHDR", then width and height as 4-byte big-endian each.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24) return null
  if (signature.some((b, i) => bytes[i] !== b)) return null
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Decode only the first few base64 characters, enough to read IHDR; the full image need not be decoded.
export function decodeBase64Prefix(base64: string, maxBytes: number): Uint8Array {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of base64) {
    if (out.length >= maxBytes || ch === '=') break
    const value = BASE64.indexOf(ch)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

// Make the background transparent so the image sits on the terminal's own background. Leave it alone if the code has its own init directive.
export function withTransparentBackground(code: string): string {
  if (/^\s*%%\{\s*init/.test(code)) return code
  return `%%{init: {"themeVariables": {"background": "transparent"}}}%%\n${code}`
}

// Output of mmdr --size: { "width": 246.3, "height": 308.255, ... }
export function parseSize(stdout: string): { width: number; height: number } | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { width, height } = parsed as { width?: unknown; height?: unknown }
    if (typeof width !== 'number' || typeof height !== 'number') return null
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

// Diagram type (flowchart, sequenceDiagram, ...), shown as alt text when the diagram can't be rendered.
export function mermaidAlt(code: string): string {
  const first = code
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '' && !line.startsWith('%%'))
  const kind = first?.split(/[\s;]/)[0] ?? ''
  return kind === '' ? 'mermaid' : `mermaid ${kind}`
}

export function renderMermaid($: MermaidEngine, code: string, options: MermaidOptions): Promise<MermaidImage | null> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const key = `${options.isDark ? 'dark' : 'light'}\n${Math.floor(options.columns)}\n${maxRows}\n${code}`
  const hit = cache.get(key)
  if (hit) return hit
  const pending = render($, code, options.columns, maxRows, options.isDark).catch(() => null)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '')
  cache.set(key, pending)
  // A failure can be passing (mmdr timing out while many renders run during streaming); forget it so a redraw retries.
  // mmdr answers in milliseconds, so retrying code that never parses costs little.
  void pending.then(image => {
    if (image === null && cache.get(key) === pending) cache.delete(key)
  })
  return pending
}

// mmdr's dark theme derives pie slices from its near-black primary colors, so a slice can vanish into a dark terminal;
// a fixed palette keeps every slice readable, with section labels drawn in the opposite tone.
// Passed as a config file (-c): mmdr reads pie1..pie12 from there but ignores them in a %%{init}%% directive (0.3.1).
const PALETTES = {
  dark: ['#7aa2f7', '#e0af68', '#9ece6a', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca', '#c0caf5', '#2ac3de', '#d4b483', '#db4b4b'],
  light: ['#2e7de9', '#b15c00', '#587539', '#c64343', '#7847bd', '#007197', '#965027', '#387068', '#6172b0', '#118c74', '#8c6c3e', '#a8323a'],
}

function themeConfig(isDark: boolean): string {
  const colors = isDark ? PALETTES.dark : PALETTES.light
  const vars: Record<string, string> = { pieSectionTextColor: isDark ? '#1a1b26' : '#ffffff' }
  colors.forEach((color, i) => (vars[`pie${i + 1}`] = color))
  return JSON.stringify({ themeVariables: vars })
}

// One config file per tone, written once per process; on failure mmdr runs with its own colors.
const configPaths = new Map<boolean, Promise<string | null>>()

export function configPath($: MermaidEngine, isDark: boolean): Promise<string | null> {
  const known = configPaths.get(isDark)
  if (known) return known
  const pending = (async () => {
    const temp = await $.process.run(['mktemp', '--tmpdir', `readable-chat-mmdr-${isDark ? 'dark' : 'light'}-XXXXXX`])
    const path = temp.stdout.trim()
    if (temp.exitCode !== 0 || !path.startsWith('/')) return null
    const written = await $.process.run(['sh', '-c', 'printf %s "$1" > "$2"', 'sh', themeConfig(isDark), path])
    return written.exitCode === 0 ? path : null
  })().catch(() => null)
  configPaths.set(isDark, pending)
  return pending
}

async function render(
  $: MermaidEngine,
  code: string,
  columns: number,
  maxRows: number,
  isDark: boolean,
): Promise<MermaidImage | null> {
  const source = withTransparentBackground(code)
  const theme = isDark ? 'dark' : 'default'
  const config = await configPath($, isDark)
  const colors = config ? ['-c', config] : []

  // First ask for the natural size, compute the cell counts, then render at the box's proportions; given a width and height, mmdr centers with padding rather than stretching.
  const sized = await $.process.run(['mmdr', '-i', '-', '--size', '-t', theme, ...colors], { stdin: source, timeoutMs: 5000 })
  if (sized.exitCode !== 0) return null
  const natural = parseSize(sized.stdout)
  if (!natural) return null
  const box = fitCells(natural.width, natural.height, columns, maxRows)
  if (!box) return null

  // stdout gets decoded as UTF-8 text, so the PNG can't come from there; it has to be written to a temp file first.
  const temp = await $.process.run(['mktemp', '--tmpdir', 'readable-chat-mermaid-XXXXXX'])
  const path = temp.stdout.trim()
  if (temp.exitCode !== 0 || !path.startsWith('/')) return null
  try {
    const width = box.columns * CELL.width * RENDER_SCALE
    const height = box.rows * CELL.height * RENDER_SCALE
    const drawn = await $.process.run(
      ['mmdr', '-i', '-', '-o', path, '-e', 'png', '-t', theme, ...colors, '-w', String(width), '-H', String(height)],
      { stdin: source, timeoutMs: 10000 },
    )
    if (drawn.exitCode !== 0) return null
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    if (base64ByteLength(base64) > MAX_PNG_BYTES) return null
    const size = pngSize(decodeBase64Prefix(base64, 24))
    if (!size) return null
    return {
      source: { png: base64 },
      columns: box.columns,
      rows: box.rows,
      alt: mermaidAlt(code),
      width: size.width,
      height: size.height,
    }
  } finally {
    await $.process.run(['rm', '-f', path]).catch(() => null)
  }
}
