import type { EngineInterface, FsBytes } from 'claude-code'

import type { ImageRef } from '../types'
import type { Places } from './links'
import { MAX_PNG_BYTES, base64ByteLength, decodeBase64Prefix, fitCells, pngSize } from './mermaid'

// Markdown images in replies. leaf 1.29.1 strips `![alt](src)` down to the alt text, so the source is rewritten before leaf sees it:
// an image standing alone in its paragraph becomes a fenced block leaf draws as a `┌─ readable-image` frame (swapped for an Image, like mermaid),
// and an image inside a sentence becomes `alt（src）` so the path or URL stays visible and links.ts can make it clickable.

export const IMAGE_LANG = 'readable-image'

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
// ATX headings and thematic breaks end a paragraph without a blank line, so `# Title\n![a](b.png)` still counts as a standalone image.
const BLOCK_BREAK = /^ {0,3}(?:#{1,6}(?:\s|$)|([-*_])(?:\s*\1){2,}\s*$)/
// `![alt](src)`, `![alt](<src with spaces>)`, an optional title in "", '' or (), and one level of balanced parentheses inside src.
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g

type Target = { kind: 'local' | 'remote'; src: string }

function decoded(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

// Drop `.` and resolve `..` so the displayed path is the one stat will see.
function normalized(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

// Where an image source points, or null for schemes there is nothing to load from (data:, mailto:, ...).
function target(raw: string, places: Places): Target | null {
  const src = raw.startsWith('<') ? raw.slice(1, -1).trim() : raw
  if (src === '') return null
  if (/^https?:\/\//i.test(src)) return { kind: 'remote', src }
  if (/^file:\/\//i.test(src)) {
    // file:///a and file://localhost/a are local; file://otherhost/a names a file on another machine.
    const rest = src.slice('file://'.length).replace(/^localhost(?=\/)/i, '')
    return rest.startsWith('/') ? { kind: 'local', src: normalized(decoded(rest)) } : null
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null
  const path = decoded(src)
  if (path.startsWith('/')) return { kind: 'local', src: normalized(path) }
  if (path === '~' || path.startsWith('~/')) return { kind: 'local', src: normalized(places.home + path.slice(1)) }
  return { kind: 'local', src: normalized(`${places.cwd}/${path}`) }
}

function asText(alt: string, raw: string, places: Places): string {
  const where = target(raw, places)?.src
  if (!where) return alt
  return alt === '' ? where : `${alt}（${where}）`
}

// Rewrite inline images outside inline code spans; backtick runs split the line, and odd pieces are code.
function inlined(line: string, places: Places): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((piece, i) => (i % 2 === 1 ? piece : piece.replace(IMAGE, (_, alt: string, raw: string) => asText(alt, raw, places))))
    .join('')
}

function isImageOnly(line: string): boolean {
  if (!/^ {0,3}\S/.test(line)) return false
  const rest = line.replace(IMAGE, '')
  return rest !== line && rest.trim() === ''
}

export function extractImages(markdown: string, places: Places): { text: string; images: ImageRef[] } {
  const images: ImageRef[] = []
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  let paragraph: string[] = []

  const flush = () => {
    if (paragraph.length === 0) return
    // A paragraph indented four or more spaces is an indented code block (or list continuation); leave it as written.
    if (/^(?: {4}|\t)/.test(paragraph[0] ?? '')) {
      out.push(...paragraph)
    } else if (paragraph.every(isImageOnly)) {
      const blocks: string[] = []
      for (const line of paragraph) {
        for (const match of line.matchAll(IMAGE)) {
          const alt = match[1] ?? ''
          const raw = match[2] ?? ''
          const where = target(raw, places)
          if (where) {
            blocks.push(`\`\`\`${IMAGE_LANG}\n${images.length}\n\`\`\``)
            images.push({ kind: where.kind, src: where.src, alt })
          } else {
            blocks.push(asText(alt, raw, places))
          }
        }
      }
      out.push(blocks.join('\n\n'))
    } else {
      out.push(...paragraph.map(line => inlined(line, places)))
    }
    paragraph = []
  }

  for (const line of markdown.split('\n')) {
    if (fence) {
      out.push(line)
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1]
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(line)?.[1]
    if (open) {
      flush()
      out.push(line)
      fence = { char: open[0] ?? '`', length: open.length }
      continue
    }
    if (line.trim() === '') {
      flush()
      out.push(line)
      continue
    }
    if (BLOCK_BREAK.test(line)) {
      flush()
      out.push(inlined(line, places))
      continue
    }
    paragraph.push(line)
  }
  flush()
  return { text: out.join('\n'), images }
}

// Loading: everything becomes a PNG under ~/.cache/readable-chat/images and is sent as `{ png: base64 }`.
// The `{ file }` source would skip the 2 MiB limit, but it has not been seen to draw in kitty + herdr; base64 has (that is how mermaid works).

export type LoadedImage =
  | { ok: true; source: { png: string }; columns: number; rows: number; alt: string }
  | { ok: false; reason: string; alt: string }

// Only these two calls are used; pass the hooks' $, and tests can substitute a fake.
export type ImageEngine = {
  process: { run: EngineInterface['process']['run'] }
  fs: { read: (path: string, options: { as: 'bytes' }) => Promise<FsBytes> }
}

export type ImageOptions = { columns: number; maxRows: number; allowRemote: boolean }

// Widest PNG kept. Wider than any terminal is likely to show (160 cells at 10 px), small enough that most screenshots fit in 2 MiB on the first pass.
const MAX_WIDTH = 1600
// Tried in order when a PNG comes out over MAX_PNG_BYTES; photos and noisy screenshots compress badly as PNG.
const WIDTHS = [MAX_WIDTH, 1200, 900, 640]
const MAX_LOCAL_BYTES = 50 * 1024 * 1024
// A tiny PNG can claim 50000×50000; refuse before ImageMagick allocates the pixel cache for it.
const MAX_PIXELS = 100_000_000

// GitHub camo's defaults (atmos/camo): 5 MiB, 4 redirects, 10 s socket timeout.
const MAX_REMOTE_BYTES = 5242880
const MAX_REDIRECTS = 4
const REMOTE_TIMEOUT_S = 10

// MIME type from `file` (libmagic reads the bytes, not the name) to the ImageMagick coder. The coder is always given explicitly
// so ImageMagick never guesses: a file that sniffs as PNG is decoded only as PNG, and SVG or MVG never reach its own renderers.
const LOCAL_TYPES: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
  'image/bmp': 'BMP',
  'image/x-ms-bmp': 'BMP',
  'image/svg+xml': 'SVG',
}
// No SVG remotely: it can reference other files and URLs, and the renderer would follow them.
const REMOTE_TYPES: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
}

// While streaming, the same reply is drawn repeatedly; caching the Promise lets concurrent requests share one load.
const cache = new Map<string, Promise<LoadedImage>>()
const CACHE_LIMIT = 100
let cacheDir: Promise<string | null> | null = null

export function clearImageCache(): void {
  cache.clear()
  cacheDir = null
  isBsdStat = false
}

export function loadImage($: ImageEngine, ref: ImageRef, options: ImageOptions): Promise<LoadedImage> {
  const columns = Math.floor(options.columns)
  const maxRows = Math.floor(options.maxRows)
  const key = `${ref.kind}\n${ref.src}\n${columns}\n${maxRows}\n${options.allowRemote}`
  const hit = cache.get(key)
  if (hit) return hit
  const pending = load($, ref, columns, maxRows, options.allowRemote).catch(
    (): LoadedImage => ({ ok: false, reason: '無法載入', alt: ref.alt }),
  )
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '')
  cache.set(key, pending)
  return pending
}

type Prepared = { ok: true; path: string } | { ok: false; reason: string }

async function load($: ImageEngine, ref: ImageRef, columns: number, maxRows: number, allowRemote: boolean): Promise<LoadedImage> {
  const fail = (reason: string): LoadedImage => ({ ok: false, reason, alt: ref.alt })
  let prepared: Prepared
  if (ref.kind === 'local') prepared = await prepareLocal($, ref.src)
  else if (ref.kind === 'remote') prepared = allowRemote ? await prepareRemote($, ref.src) : { ok: false, reason: '遠端圖片未開啟，/images remote on 打開' }
  else return fail('不支援')
  if (!prepared.ok) return fail(prepared.reason)

  const { base64 } = await $.fs.read(prepared.path, { as: 'bytes' })
  if (base64ByteLength(base64) > MAX_PNG_BYTES) return fail('超過 2 MiB')
  const size = pngSize(decodeBase64Prefix(base64, 24))
  if (!size) return fail('無法讀取')
  // fitCells never goes past the image's own width in cells, so small images stay small. The natural size here is the cached PNG's,
  // at most MAX_WIDTH, which is already wider than the space a reply gets.
  const box = fitCells(size.width, size.height, columns, maxRows)
  if (!box) return fail('無法讀取')
  return { ok: true, source: { png: base64 }, columns: box.columns, rows: box.rows, alt: ref.alt }
}

function run($: ImageEngine, argv: readonly string[], timeoutMs: number, stdin?: string) {
  return $.process.run(argv, stdin === undefined ? { timeoutMs } : { stdin, timeoutMs })
}

type Stat = { kind: string; size: number; mtime: number }

// GNU stat (Linux) takes --format; macOS ships BSD stat, which refuses it and takes -f with its own codes. Both print the same three
// fields: file type, size in bytes, mtime in seconds. Only BSD's usage error switches over: GNU's -f means file system, so falling
// back on any failure, such as a missing file, could leave Linux on the wrong form. Once BSD stat answers, later calls go to it directly.
const BSD_USAGE_ERROR = /illegal option|usage: stat/
const GNU_STAT = ['stat', '-L', '--format=%F\t%s\t%Y', '--']
const BSD_STAT = ['stat', '-L', '-f', '%HT%t%z%t%m', '--']
let isBsdStat = false

// `-L` follows a symlink, so a link to a regular file counts as one. The type is "regular file" or "regular empty file" from GNU,
// "Regular File" from BSD.
async function stat($: ImageEngine, path: string): Promise<Stat | null> {
  let result = await run($, [...(isBsdStat ? BSD_STAT : GNU_STAT), path], 5000)
  if (result.exitCode !== 0 && !isBsdStat && BSD_USAGE_ERROR.test(result.stderr)) {
    result = await run($, [...BSD_STAT, path], 5000)
    if (result.exitCode === 0) isBsdStat = true
  }
  if (result.exitCode !== 0) return null
  const [kind = '', size = '', mtime = ''] = result.stdout.trim().split('\t')
  return { kind, size: Number(size), mtime: Number(mtime) }
}

function isRegular(info: Stat | null): boolean {
  return info !== null && info.kind.toLowerCase().startsWith('regular')
}

async function hash($: ImageEngine, text: string): Promise<string | null> {
  const result = await run($, ['sha256sum'], 5000, text)
  const digest = result.stdout.split(/\s/)[0] ?? ''
  return result.exitCode === 0 && /^[0-9a-f]{64}$/.test(digest) ? digest : null
}

async function imageCacheDir($: ImageEngine): Promise<string | null> {
  cacheDir ??= run($, ['sh', '-c', 'dir="$HOME/.cache/readable-chat/images" && mkdir -p -- "$dir" && printf %s "$dir"'], 5000)
    .then(result => (result.exitCode === 0 && result.stdout.startsWith('/') ? result.stdout : null))
    .catch(() => null)
  const dir = await cacheDir
  if (dir === null) cacheDir = null
  return dir
}

async function mimeType($: ImageEngine, path: string): Promise<string> {
  const result = await run($, ['file', '--brief', '--dereference', '--mime-type', '--', path], 5000)
  return result.exitCode === 0 ? result.stdout.trim() : ''
}

// Decode the header only (-ping) with the coder fixed, which both checks the bytes really are that format and reads the size.
async function identify($: ImageEngine, coder: string, path: string): Promise<{ width: number; height: number } | null> {
  const result = await run($, ['magick', 'identify', '-ping', '-format', '%w %h\n', `${coder}:${path}[0]`], 10000)
  if (result.exitCode !== 0) return null
  const [width = 0, height = 0] = (result.stdout.split('\n')[0] ?? '').split(' ').map(Number)
  return width > 0 && height > 0 ? { width, height } : null
}

async function hasCommand($: ImageEngine, name: string): Promise<boolean> {
  const result = await run($, ['sh', '-c', 'command -v "$1" >/dev/null', 'sh', name], 5000).catch(() => null)
  return result?.exitCode === 0
}

async function prepareLocal($: ImageEngine, path: string): Promise<Prepared> {
  const info = await stat($, path)
  if (!info) return { ok: false, reason: '檔案不存在' }
  if (!isRegular(info)) return { ok: false, reason: '不是一般檔案' }
  if (info.size > MAX_LOCAL_BYTES) return { ok: false, reason: '超過 50 MB' }
  const coder = LOCAL_TYPES[await mimeType($, path)]
  if (!coder) return { ok: false, reason: '不支援的格式' }
  const dir = await imageCacheDir($)
  const key = await hash($, `local\n${path}\n${info.mtime}\n${info.size}`)
  if (!dir || !key) return { ok: false, reason: '無法建立快取' }
  const out = `${dir}/${key}.png`
  if (isRegular(await stat($, out))) return { ok: true, path: out }
  return coder === 'SVG' ? convertSvg($, path, out) : convertRaster($, coder, path, out)
}

// resvg renders a static subset of SVG and never touches the network; librsvg (rsvg-convert) loads images the SVG references
// from its own directory and below, so a model-written SVG can pull in neighbouring files. Prefer resvg when it is installed.
async function convertSvg($: ImageEngine, path: string, out: string): Promise<Prepared> {
  const raster = `${out}.svg.png`
  try {
    const argv = (await hasCommand($, 'resvg'))
      ? ['resvg', '--', path, raster]
      : ['rsvg-convert', '--format=png', '--output', raster, '--', path]
    const drawn = await run($, argv, 15000)
    if (drawn.exitCode !== 0) return { ok: false, reason: '轉換失敗' }
    return await convertRaster($, 'PNG', raster, out)
  } finally {
    await run($, ['rm', '-f', '--', raster], 5000).catch(() => null)
  }
}

async function convertRaster($: ImageEngine, coder: string, path: string, out: string): Promise<Prepared> {
  const size = await identify($, coder, path)
  if (!size) return { ok: false, reason: '不支援的格式' }
  if (size.width * size.height > MAX_PIXELS) return { ok: false, reason: '圖片太大' }
  const temp = `${out}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    for (const width of WIDTHS) {
      // [0] keeps only the first frame of a GIF or animated WebP; -auto-orient applies the EXIF rotation that phone photos rely on;
      // `>` only ever shrinks. Writing to a temp name and renaming keeps a half-written PNG out of the cache.
      const drawn = await run(
        $,
        ['magick', `${coder}:${path}[0]`, '-auto-orient', '-resize', `${width}x>`, '-strip', `PNG:${temp}`],
        20000,
      )
      if (drawn.exitCode !== 0) return { ok: false, reason: '轉換失敗' }
      const written = await stat($, temp)
      if (!written) return { ok: false, reason: '轉換失敗' }
      if (written.size <= MAX_PNG_BYTES) {
        const moved = await run($, ['mv', '-f', '--', temp, out], 5000)
        return moved.exitCode === 0 ? { ok: true, path: out } : { ok: false, reason: '轉換失敗' }
      }
    }
    return { ok: false, reason: '轉換後超過 2 MiB' }
  } finally {
    await run($, ['rm', '-f', '--', temp], 5000).catch(() => null)
  }
}

// Remote images. A URL in a reply may come from a web page or tool output, so fetching it tells that host the user's IP and reading time,
// and could point at localhost or the LAN. Hence off by default, https only, and every hop's address checked before curl connects.

// Host must be a plain DNS name or a bracketed IPv6 literal, with no userinfo or backslash: anything curl might parse differently
// from this check is refused, otherwise curl could connect somewhere --resolve does not pin.
const HTTPS_URL = /^https:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#][^\s\\]*)?$/

export function parseHttpsUrl(url: string): { host: string; port: number } | null {
  const match = HTTPS_URL.exec(url)
  if (!match) return null
  const port = match[2] ? Number(match[2]) : 443
  if (!(port >= 1 && port <= 65535)) return null
  return { host: (match[1] ?? '').toLowerCase(), port }
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null
  const octets = parts.map(Number)
  return octets.every(octet => octet <= 255) ? octets : null
}

// Eight 16-bit groups, expanding `::` and a trailing dotted IPv4 (::ffff:127.0.0.1).
function parseIPv6(address: string): number[] | null {
  let text = address.replace(/%.*$/, '')
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (dotted) {
    const v4 = parseIPv4(dotted)
    if (!v4) return null
    const [a = 0, b = 0, c = 0, d = 0] = v4
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (half: string) => (half === '' ? [] : half.split(':'))
  const head = groups(halves[0] ?? '')
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (all.some(group => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null
  return all.map(group => parseInt(group, 16))
}

function isBlockedIPv4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, including cloud metadata at 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  )
}

// True for loopback, private, link-local, CGNAT, ULA, multicast, documentation ranges, and anything unparseable.
// IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that address.
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address)
  if (v4) return isBlockedIPv4(v4)
  const g = parseIPv6(address)
  if (!g) return true
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff || (g5 === 0 && (g6 !== 0 || g7 > 1))) return isBlockedIPv4(embedded)
    return true // :: and ::1
  }
  if (g0 === 0x64 && g1 === 0xff9b) return g2 !== 0 || isBlockedIPv4(embedded)
  if (g0 === 0x2002) return isBlockedIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff])
  if ((g0 & 0xfe00) === 0xfc00) return true // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true // link-local, old site-local
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  if (g0 === 0x2001 && (g1 === 0x0db8 || g1 === 0)) return true // documentation, Teredo
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true // discard-only
  return false
}

// One address to connect to, or why not. Every address the name resolves to must be public, so DNS answering a mix cannot slip a private one in;
// the checked address is then pinned with --resolve, so curl's own lookup cannot return something else a moment later.
async function resolvePublic($: ImageEngine, host: string): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    return isBlockedAddress(address) ? { ok: false, reason: '拒絕內網位址' } : { ok: true, address }
  }
  const result = await run($, ['getent', 'ahosts', host], 5000)
  const addresses = [...new Set(result.stdout.split('\n').map(line => line.split(/\s+/)[0] ?? '').filter(Boolean))]
  if (result.exitCode !== 0 || addresses.length === 0) return { ok: false, reason: '無法解析主機' }
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: '拒絕內網位址' }
  const address = addresses.find(a => parseIPv4(a)) ?? addresses[0] ?? ''
  return { ok: true, address }
}

async function prepareRemote($: ImageEngine, url: string): Promise<Prepared> {
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: '只抓 https 圖片' }
  const dir = await imageCacheDir($)
  const key = await hash($, `remote\n${url}`)
  if (!dir || !key) return { ok: false, reason: '無法建立快取' }
  const out = `${dir}/${key}.png`
  if (isRegular(await stat($, out))) return { ok: true, path: out }

  const download = `${dir}/${key}.download`
  try {
    let next = url
    let fetched = false
    // Redirects are followed here rather than by curl (-L), so each hop's host goes through the same address check and pinning.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = parseHttpsUrl(next)
      if (!parsed) return { ok: false, reason: hop === 0 ? '網址格式不支援' : '轉址到不支援的網址' }
      const resolved = await resolvePublic($, parsed.host)
      if (!resolved.ok) return resolved
      const pin = parsed.host.startsWith('[') ? [] : ['--resolve', `${parsed.host}:${parsed.port}:${resolved.address.includes(':') ? `[${resolved.address}]` : resolved.address}`]
      const fetchedHop = await run(
        $,
        [
          'curl',
          '-q', // ignore ~/.curlrc, which could add -L or a proxy
          '--silent',
          '--show-error',
          '--globoff',
          '--noproxy', '*', // a proxy would do its own DNS lookup and bypass the pinned address
          '--proto', '=https',
          '--proto-redir', '=https',
          '--max-redirs', String(MAX_REDIRECTS),
          '--max-time', String(REMOTE_TIMEOUT_S),
          '--max-filesize', String(MAX_REMOTE_BYTES),
          '--header', 'Accept: image/png,image/jpeg,image/gif,image/webp',
          ...pin,
          '--output', download,
          '--write-out', '%{http_code}\n%{redirect_url}',
          '--',
          next,
        ],
        (REMOTE_TIMEOUT_S + 5) * 1000,
      )
      if (fetchedHop.exitCode === 63) return { ok: false, reason: '超過 5 MB' }
      if (fetchedHop.exitCode === 28) return { ok: false, reason: '下載逾時' }
      if (fetchedHop.exitCode !== 0) return { ok: false, reason: '下載失敗' }
      const [code = '', location = ''] = fetchedHop.stdout.split('\n')
      const status = Number(code)
      if (status >= 300 && status < 400 && location.trim() !== '') {
        next = location.trim()
        continue
      }
      if (status !== 200) return { ok: false, reason: `下載失敗（HTTP ${code}）` }
      fetched = true
      break
    }
    if (!fetched) return { ok: false, reason: `轉址超過 ${MAX_REDIRECTS} 次` }

    // --max-filesize cannot stop a body without Content-Length on every curl version; check what actually landed.
    const info = await stat($, download)
    if (!info || !isRegular(info)) return { ok: false, reason: '下載失敗' }
    if (info.size > MAX_REMOTE_BYTES) return { ok: false, reason: '超過 5 MB' }
    // The server's Content-Type is not trusted; the format comes from the bytes.
    const coder = REMOTE_TYPES[await mimeType($, download)]
    if (!coder) return { ok: false, reason: '不支援的格式' }
    return await convertRaster($, coder, download, out)
  } finally {
    await run($, ['rm', '-f', '--', download], 5000).catch(() => null)
  }
}
