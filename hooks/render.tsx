// Drawing shared by the transcript (register.tsx) and the reader pane (pane.tsx): running leaf, its theme and cache,
// turning leaf's lines into elements, and the small actions their buttons take.
// It holds no state atoms: the state scan only follows atoms made in a const of the file that reads them.

import type { EngineInterface, ElementTable, ImageSource, RenderElement, RenderSurface } from 'claude-code'

import { parseAnsi } from './ansi'
import type { Line } from './ansi'
import { cardifyTables, lineCount, mermaidBlocks } from './format'
import { IMAGE_LANG, loadImage } from './images'
import { linkify } from './links'
import type { Places } from './links'
import { MATH_FRAME, MATH_FRAME_BOTTOM, isComplexMath, mathAlt, mathBlocks, renderMath } from './math'
import { mermaidAlt, renderMermaid } from './mermaid'
import type { ImageRef } from '../types'

export const PANE = 'reader'

// The same message comes in again while streaming and on every redraw; leaf takes about 4 ms per run, and the cache keeps redraws from spawning another process.
// null means leaf could not run; fall back to the engine's own markdown in that case.
const rendered = new Map<string, Line[] | null>()

// Bumped whenever the cache is dropped (a theme or color mode change), so callers that keep what they drew from leaf's
// lines know those lines are stale.
let generation = 0
export function renderGeneration(): number {
  return generation
}

function clearRendered() {
  rendered.clear()
  generation++
}

// Relative paths and `~/` must become absolute file:// URLs to be clickable; filled in at session.start.
export const places: Places = { cwd: '.', home: '~' }

// leaf's colors follow the Omarchy theme: bin/leaf-theme.sh generates a TOML file from the current theme and prints the arguments to pass to leaf.
// watchTheme notices a switch within THEME_POLL_MS and redraws every reply at once. Every session points leaf at the same generated
// file, so a 30 s check with no redraw let replies drawn after another session regenerated the file come out in the new colors
// while cached and on-screen ones kept the old, each flipping whenever it happened to redraw.
const THEME_REFRESH_MS = 30_000
const THEME_POLL_MS = 2000
const THEME_DIR = '.local/state/omarchy/current/theme'
// The files leaf-theme.sh takes its colors from, in its order; reading them costs a few hundred bytes per poll.
const THEME_SOURCES = ['foot.ini', 'colors.toml']
const THEME_RETRIES = 3
const THEME_RETRY_MS = 2000
const theme = {
  args: [] as string[],
  stamp: '',
  checkedAt: -Infinity,
  failures: 0,
  isDark: true,
  source: undefined as string | undefined,
}

// If the theme cannot be read, use leaf's default colors; a theme problem must not block rendering the whole reply.
async function themeArgs($: EngineInterface): Promise<readonly string[]> {
  try {
    return await refreshTheme($)
  } catch {
    return theme.args
  }
}

async function themeSource($: EngineInterface, home: string): Promise<string> {
  for (const file of THEME_SOURCES) {
    const text = await $.fs.read(`${home}/${THEME_DIR}/${file}`).catch(() => undefined)
    if (typeof text === 'string') return text
  }
  return ''
}

/** Polls the theme's color file; on a change, regenerates leaf's theme and redraws every reply in the new colors together. */
export function watchTheme($: EngineInterface, home: string): { cancel: () => void } {
  let busy = false
  return $.clock.every(THEME_POLL_MS, () => {
    if (busy) return
    busy = true
    void (async () => {
      // /reader-colors in one session saves the mode to $.store; every other open session picks it up here and redraws.
      const saved = await Promise.resolve()
        .then(() => $.store.get(COLOR_MODE_KEY))
        .catch(() => undefined)
      const mode: ColorMode = saved === 'leaf' ? 'leaf' : 'system'
      if (mode !== colorMode) {
        await applyColorMode($, mode)
        return
      }
      const text = await themeSource($, home)
      const first = theme.source === undefined
      if (text === theme.source) return
      theme.source = text
      // The first read only records the theme the session started with; the render path generated its leaf theme already.
      if (first) return
      theme.checkedAt = -Infinity
      const before = theme.stamp
      await refreshTheme($)
      if (theme.stamp !== before) $.ui.invalidate('ui.render')
    })()
      .catch(() => undefined)
      .finally(() => {
        busy = false
      })
  })
}

// `system` follows the Omarchy theme through leaf-theme.sh; `leaf` keeps leaf's own colors whatever the desktop uses.
// Kept in $.store, so the choice holds across sessions; /reader-colors switches it.
export type ColorMode = 'system' | 'leaf'
const COLOR_MODE_KEY = 'colorMode'
let colorMode: ColorMode = 'system'

export async function loadColorMode($: EngineInterface): Promise<ColorMode> {
  const saved = await $.store.get(COLOR_MODE_KEY).catch(() => undefined)
  colorMode = saved === 'leaf' ? 'leaf' : 'system'
  return colorMode
}

export async function setColorMode($: EngineInterface, mode: ColorMode): Promise<void> {
  await $.store.set(COLOR_MODE_KEY, mode)
  await applyColorMode($, mode)
}

async function applyColorMode($: EngineInterface, mode: ColorMode): Promise<void> {
  colorMode = mode
  theme.checkedAt = -Infinity
  theme.failures = 0
  await refreshTheme($)
  clearRendered()
  $.ui.invalidate('ui.render')
}

async function refreshTheme($: EngineInterface): Promise<readonly string[]> {
  if (colorMode === 'leaf') {
    if (theme.stamp !== 'leaf') {
      clearRendered()
      theme.stamp = 'leaf'
      theme.args = []
      // leaf's default theme is dark.
      theme.isDark = true
    }
    return theme.args
  }
  if (theme.stamp === 'leaf') theme.stamp = ''
  const now = await $.clock.now()
  if (now - theme.checkedAt < THEME_REFRESH_MS) return theme.args
  theme.checkedAt = now
  const run = await $.process.run(['bash', `${$.plugin.root}/bin/leaf-theme.sh`], { timeoutMs: 5000 }).catch(() => null)
  const args = run?.exitCode === 0 ? run.stdout.split('\n').filter(line => line !== '') : []
  // A failed run (a theme switch midway, a slow machine, the script being edited) keeps the last good theme and is tried
  // again on the next render; dropping to [] painted replies in leaf's default green and blue until something redrew them.
  // Without Omarchy it fails every time, so after THEME_RETRIES failures in a row leaf's defaults are the theme.
  if (args.length === 0 && ++theme.failures < THEME_RETRIES) {
    theme.checkedAt = now - THEME_REFRESH_MS + THEME_RETRY_MS
    return theme.args
  }
  if (args.length === 0 && theme.args.length > 0) return theme.args
  const isRecovered = args.length > 0 && theme.failures > 0
  if (args.length > 0) theme.failures = 0
  const file = args[args.indexOf('--theme') + 1]
  const stat = file ? await $.process.run(['stat', '-c', '%Y', file]).catch(() => null) : null
  const stamp = `${args.join(' ')} ${stat?.stdout.trim() ?? ''}`
  if (stamp !== theme.stamp) {
    // Replies drawn before the theme could be read are on screen in leaf's defaults; redraw them now. A switch between two
    // themes is redrawn by watchTheme.
    clearRendered()
    if (isRecovered) $.ui.invalidate('ui.render')
    // leaf-theme.sh uses arctic as the base for light themes; mermaid diagrams switch to light as well.
    const base = file ? await $.process.run(['grep', '-q', 'arctic', file]).catch(() => null) : null
    theme.isDark = base?.exitCode !== 0
  }
  theme.args = args
  theme.stamp = stamp
  return args
}

// Before sending to leaf, turn tables that do not fit into cards: leaf only wraps inside cells, so with many columns each cell is left with a few characters.
export async function renderWithLeaf($: EngineInterface, source: string, width: number): Promise<Line[] | null> {
  const text = cardifyTables(source, width)
  const key = `${width}\n${text}`
  const hit = rendered.get(key)
  if (hit !== undefined) return hit
  let lines: Line[] | null = null
  try {
    const run = await $.process.run(['leaf', '--inline', `ansi:${Math.max(20, width)}`, ...(await themeArgs($))], {
      stdin: text,
      timeoutMs: 5000,
    })
    if (run.exitCode === 0 && run.stdout.trim() !== '') lines = linkify(parseAnsi(run.stdout), text, places)
  } catch {
    lines = null
  }
  // Without the theme the lines are in leaf's default colors; leave them out of the cache so the next redraw tries again.
  if (theme.failures > 0 && theme.failures < THEME_RETRIES) return lines
  if (rendered.size >= 300) rendered.delete(rendered.keys().next().value ?? '')
  rendered.set(key, lines)
  return lines
}

export type FileTarget = NonNullable<Line[number]['file']>

export type Opener = (file: FileTarget) => Promise<unknown>

export type Elements = Pick<ElementTable, 'Box' | 'Button' | 'Link' | 'Text'> & { Image?: ElementTable<'terminal'>['Image'] }

export type DrawOptions = {
  // In fullscreen, clicks are reported to the mod: file paths are drawn as a plain Button handled by open; without it, as a file:// Link.
  open?: Opener
  // A copy button to the right of each code block's frame, copying the raw text of block n.
  copyCode?: (index: number) => Promise<unknown>
  // Each heading line is wrapped in a keyed Box so outline and table-of-contents buttons can scroll to it with $.ui.scroll.
  headingKeys?: { titles: readonly string[]; key: (index: number) => string }
  // Pictures drawn in place of leaf's image, mermaid and math frames (loadPictures); absent keeps every frame as leaf drew it.
  pictures?: Pictures
  // Replies from earlier turns draw every span dim (focus mode), so the current turn is the brightest text on screen.
  // The value names the reply's hover group: the pointer anywhere over the reply lights all of it, and leaving dims it again.
  dimScope?: string
  // An element drawn just before span i of line row (the pane's keyboard labels). A Button cannot sit inside a Text,
  // so a line with one is drawn as a row of elements instead of one truncating Text.
  hint?: (row: number, index: number) => RenderElement | undefined
  keyPrefix: string
}

// Frames leaf draws for the blocks that become pictures, matched against a row's trimmed text.
// A mermaid frame leaf draws as a diagram has no line-number gutter, so its bottom is `└────┘`; one leaf cannot draw
// (xychart-beta in leaf 1.28) is a code frame, like readable-image, and ends `└─┴───┘`.
const MERMAID_TOP = /^┌─ mermaid /
const MERMAID_BOTTOM = /^└─*(?:┴─*)?┘$/
const IMAGE_TOP = new RegExp(`^┌─ ${IMAGE_LANG} `)
// The one row inside a readable-image frame: gutter `│1│`, then the image's index that extractImages wrote into the fence.
const IMAGE_INDEX = /^│\s*1│\s*(\d+)\s*│$/
const CODE_BOTTOM = /^└─*┴─*┘$/

// Image props for anything the mod rasterized: a Markdown image, a mermaid diagram or a formula.
export type Drawable = { source: ImageSource; columns: number; rows: number; alt: string }

// One picture of a reply. id is stable within the reply and names its kind (img0, mmd0, math0), so the 「原始碼」 toggle of
// one picture never lands on another when a reply mixes kinds.
export type Picture = {
  id: string
  ref: ImageRef
  // null when it could not be drawn; reason says why for Markdown images (empty on surfaces without Image).
  image: Drawable | null
  reason?: string
  isSource: boolean
}

export type Pictures = {
  // By the index extractImages wrote into each readable-image fence.
  images: readonly Picture[]
  // By order of appearance. A missing entry (no Image on this surface, or simple math) keeps leaf's frame without a caption.
  mermaid: readonly (Picture | undefined)[]
  math: readonly (Picture | undefined)[]
  toggleSource?: (id: string) => Promise<unknown>
  zoom?: (ref: ImageRef) => Promise<unknown>
}

export type PictureOptions = {
  // The width leaf was given; math frames are counted from the same cardified text leaf saw.
  columns: number
  surface: RenderSurface
  allowRemote: boolean
  isSource: (id: string) => boolean
  // Taller pictures push the rest of a reply off screen; 「放大」 opens one in the desktop's image viewer to read it large.
  maxRows?: { image: number; mermaid: number; math: number }
}

const TRANSCRIPT_ROWS = { image: 20, mermaid: 25, math: 10 }

export async function isDarkTheme($: EngineInterface): Promise<boolean> {
  await themeArgs($)
  return theme.isDark
}

// Load every picture of a reply at once: images, diagrams and formulas are independent processes, and each module caches its
// Promise, so a redraw while streaming waits only for what is new. `text` is the source after extractImages, as leaf is given it.
export async function loadPictures(
  $: EngineInterface,
  text: string,
  images: readonly ImageRef[],
  options: PictureOptions,
): Promise<Pictures> {
  const rows = options.maxRows ?? TRANSCRIPT_ROWS
  const isTerminal = options.surface === 'terminal'
  const isDark = isTerminal ? await isDarkTheme($) : true
  const imageJobs = images.map(async (ref, i): Promise<Picture> => {
    const id = `img${i}`
    const isSource = options.isSource(id)
    if (!isTerminal || isSource) return { id, ref, image: null, reason: '', isSource }
    const loaded = await loadImage($, ref, { columns: options.columns, maxRows: rows.image, allowRemote: options.allowRemote })
    return loaded.ok
      ? { id, ref, image: { source: loaded.source, columns: loaded.columns, rows: loaded.rows, alt: loaded.alt || ref.src }, isSource }
      : { id, ref, image: null, reason: loaded.reason, isSource }
  })
  const mermaidJobs = isTerminal
    ? mermaidBlocks(text).map(async (code, i): Promise<Picture> => {
        const id = `mmd${i}`
        const ref: ImageRef = { kind: 'mermaid', src: code, alt: mermaidAlt(code) }
        const isSource = options.isSource(id)
        const image = isSource
          ? null
          : await renderMermaid($, code, { columns: options.columns, isDark, maxRows: rows.mermaid }).catch(() => null)
        return { id, ref, image, isSource }
      })
    : []
  // Only formulas leaf flattens badly become images; the rest read fine as leaf's Unicode and stay text.
  const mathJobs = isTerminal
    ? mathBlocks(cardifyTables(text, options.columns)).map(async (tex, i): Promise<Picture | undefined> => {
        if (!isComplexMath(tex)) return undefined
        const id = `math${i}`
        const ref: ImageRef = { kind: 'math', src: tex, alt: mathAlt(tex) }
        const isSource = options.isSource(id)
        const image = isSource
          ? null
          : await renderMath($, tex, { columns: options.columns, isDark, maxRows: rows.math }).catch(() => null)
        return { id, ref, image, isSource }
      })
    : []
  const [loadedImages, mermaid, math] = await Promise.all([
    Promise.all(imageJobs),
    Promise.all(mermaidJobs),
    Promise.all(mathJobs),
  ])
  return { images: loadedImages, mermaid, math }
}

// What 「原始碼」 shows: the Markdown that named the image, or the diagram or TeX source.
export function pictureSource(ref: ImageRef): string {
  return ref.kind === 'local' || ref.kind === 'remote' ? `![${ref.alt}](${ref.src})` : ref.src
}

// Any frame's bottom row; rows inside a frame end with its `│` border, so the first such row closes the frame.
const ANY_FRAME_BOTTOM = /└[─┴]*┘$/

// Index of the row ending the frame that starts at row, or -1 when there is none (a frame cut off while streaming, or one
// that closes with a bottom other than expected). Stopping at the first bottom keeps a later frame from being swallowed.
function frameEnd(lines: readonly Line[], row: number, bottom: RegExp): number {
  for (let at = row + 1; at < lines.length; at++) {
    const plain = plainLine(lines[at] ?? [])
    if (ANY_FRAME_BOTTOM.test(plain)) return bottom.test(plain) ? at : -1
  }
  return -1
}

const CAPTION_ALT = 40

function shortAlt(alt: string): string {
  const flat = alt.replace(/\s+/g, ' ').trim()
  return flat.length > CAPTION_ALT ? `${flat.slice(0, CAPTION_ALT - 1)}…` : flat
}

// The row under each picture: dim 圖：and alt (with the reason when it failed), where it came from, and its buttons.
// flexWrap lets the buttons drop to a second row in a narrow pane instead of being cut off.
function captionRow(elements: Elements, picture: Picture, pictures: Pictures, options: DrawOptions) {
  const { Box, Button, Image, Link, Text } = elements
  const { ref } = picture
  const reason = picture.reason ? `（${picture.reason}）` : ''
  const alt = shortAlt(ref.alt) || (ref.kind === 'local' || ref.kind === 'remote' ? '圖片' : '')
  const parts: RenderElement[] = [<Text dimColor>圖：{alt}{reason}</Text>]
  if (ref.kind === 'local') {
    const open = options.open
    const href = `file://${encodeURI(ref.src)}`
    parts.push(<Text> </Text>)
    parts.push(
      open ? (
        <Button key={`${options.keyPrefix}pic-open:${picture.id}`} plain onPress={() => open({ path: ref.src })}>
          <Text underline dimColor>{ref.src}</Text>
        </Button>
      ) : (
        <Link href={href}>
          <Text underline dimColor>{ref.src}</Text>
        </Link>
      ),
    )
  } else if (ref.kind === 'remote') {
    parts.push(<Text> </Text>)
    parts.push(
      <Link href={ref.src}>
        <Text underline dimColor>{ref.src}</Text>
      </Link>,
    )
  }
  const toggle = pictures.toggleSource
  if (toggle) {
    parts.push(<Text>  </Text>)
    parts.push(
      <Button key={`${options.keyPrefix}src:${picture.id}`} plain onPress={() => toggle(picture.id)}>
        <Text dimColor>[{picture.isSource ? '顯示圖' : '原始碼'}]</Text>
      </Button>,
    )
  }
  const zoom = pictures.zoom
  if (zoom && Image && picture.image && !picture.isSource) {
    parts.push(<Text> </Text>)
    parts.push(
      <Button key={`${options.keyPrefix}zoom:${picture.id}`} plain onPress={() => zoom(ref)}>
        <Text dimColor>[放大]</Text>
      </Button>,
    )
  }
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {parts}
    </Box>
  )
}

// A picture with its caption, or its source when 「原始碼」 is on, or only the caption when it could not be drawn.
function drawPicture(elements: Elements, picture: Picture, pictures: Pictures, options: DrawOptions): RenderElement[] {
  const { Image, Text } = elements
  const caption = captionRow(elements, picture, pictures, options)
  if (picture.isSource) {
    const source = pictureSource(picture.ref).split('\n')
    return [...source.map(line => <Text dimColor wrap="truncate">{line === '' ? ' ' : line}</Text>), caption]
  }
  const image = picture.image
  if (image && Image) {
    return [<Image source={image.source} columns={image.columns} rows={image.rows} alt={image.alt} />, caption]
  }
  return [caption]
}

const CODE_TOP = /^┌─/
const CODE_FIRST_LINE = /^│\s*\d+│/

export function plainLine(line: Line): string {
  return line.map(span => span.text).join('').trim()
}

function drawSpans({ Button, Link, Text }: Elements, line: Line, row: number, options: DrawOptions) {
  const { open } = options
  const lit = litOnHover(options)
  const style = (span: Line[number]) => (options.dimScope ? { ...span.style, dimColor: true, ...lit } : span.style)
  const hints = options.hint ? line.map((_, i) => options.hint?.(row, i)) : []
  const hasHint = hints.some(hint => hint !== undefined)
  if ((open && line.some(span => span.file)) || hasHint) {
    return line.flatMap((span, i) => {
      const file = open ? span.file : undefined
      const body = file ? (
        <Button key={`${options.keyPrefix}open:${row}:${i}`} plain onPress={() => open?.(file)}>
          <Text {...style(span)}>{span.text}</Text>
        </Button>
      ) : hasHint && span.href ? (
        <Text {...lit}>
          <Link href={span.href}>
            <Text {...style(span)}>{span.text}</Text>
          </Link>
        </Text>
      ) : (
        <Text {...style(span)}>{span.text}</Text>
      )
      const hint = hints[i]
      return hint ? [hint, body] : [body]
    })
  }
  return [
    <Text wrap="truncate" {...lit}>
      {line.map(span =>
        span.href ? (
          <Link href={span.href}>
            <Text {...style(span)}>{span.text}</Text>
          </Link>
        ) : (
          <Text {...style(span)}>{span.text}</Text>
        ),
      )}
    </Text>,
  ]
}

// A nested Text follows its hover group but cannot light it, so every row's outermost Text joins the group too, blank rows included,
// or the reply would flicker dim while the pointer crosses a gap between paragraphs.
function litOnHover(options: DrawOptions) {
  return options.dimScope ? { hover: { scope: options.dimScope, dimColor: false } } : {}
}

export function drawLines(elements: Elements, lines: readonly Line[], options: DrawOptions) {
  const { Box, Button, Text } = elements
  const lit = litOnHover(options)
  let code = 0
  let heading = 0
  let diagram = 0
  let mathIndex = 0
  const rows = []
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? []
    if (line.length === 0) {
      rows.push(<Text {...lit}> </Text>)
      continue
    }
    const plain = plainLine(line)

    // Picture frames: leaf's image, mermaid and math frames are swapped for the picture, or kept with a note when it failed.
    // Every math frame is handled here, drawn or not, so its `│1│` gutter is not taken for a code block and the copy buttons stay in step.
    const pictures = options.pictures
    const imageIndex = IMAGE_TOP.test(plain) ? IMAGE_INDEX.exec(plainLine(lines[row + 1] ?? []))?.[1] : undefined
    const isMath = MATH_FRAME.test(plain)
    const isMermaid = MERMAID_TOP.test(plain)
    if (isMath || (pictures && (imageIndex !== undefined || isMermaid))) {
      const end = frameEnd(lines, row, isMermaid ? MERMAID_BOTTOM : isMath ? MATH_FRAME_BOTTOM : CODE_BOTTOM)
      const picture =
        imageIndex !== undefined
          ? pictures?.images[Number(imageIndex)]
          : isMath
            ? pictures?.math[mathIndex++]
            : pictures?.mermaid[diagram++]
      if (end !== -1 && pictures && picture && (picture.isSource || picture.image || imageIndex !== undefined)) {
        rows.push(...drawPicture(elements, picture, pictures, options))
        row = end
        continue
      }
      if (end !== -1 && (isMath || isMermaid)) {
        for (; row <= end; row++) {
          const frameLine = lines[row] ?? []
          const frameSpans = drawSpans(elements, frameLine, row, options)
          rows.push(frameSpans.length === 1 ? frameSpans[0] : <Box flexDirection="row">{frameSpans}</Box>)
        }
        row = end
        // Attempted and failed: say so, or a missing image would look like leaf's choice.
        if (picture) rows.push(<Text dimColor>{isMath ? '（數學式轉圖失敗，顯示文字版）' : '（mermaid 轉圖失敗，顯示 ASCII 版）'}</Text>)
        continue
      }
    }

    const spans = drawSpans(elements, line, row, options)
    const isCodeTop = CODE_TOP.test(plain) && CODE_FIRST_LINE.test(plainLine(lines[row + 1] ?? []))
    if (isCodeTop && options.copyCode) {
      const index = code++
      const copyCode = options.copyCode
      rows.push(
        <Box flexDirection="row">
          {spans}
          <Text> </Text>
          <Button key={`${options.keyPrefix}code:${index}`} plain onPress={() => copyCode(index)}>
            <Text dimColor>⧉ 複製</Text>
          </Button>
        </Box>,
      )
      continue
    }

    // Match headings in order, looking for the next one only after a match, so a table cell with the same text is not taken for a heading.
    const titles = options.headingKeys?.titles
    if (titles && heading < titles.length && plain === titles[heading]) {
      rows.push(
        <Box key={options.headingKeys?.key(heading++)} flexDirection="row">
          {spans}
        </Box>,
      )
      continue
    }
    rows.push(spans.length === 1 ? spans[0] : <Box flexDirection="row">{spans}</Box>)
  }
  return <Box flexDirection="column">{rows}</Box>
}

export function openFile($: EngineInterface, file: FileTarget) {
  return $.process.run(
    ['bash', `${$.plugin.root}/bin/open-in-nvim.sh`, file.path, ...(file.line ? [String(file.line)] : [])],
    { timeoutMs: 10000 },
  )
}

export function opener($: EngineInterface, isFullscreen: boolean | undefined): Opener | undefined {
  if (isFullscreen !== true) return undefined
  return file => openFile($, file)
}

export async function copy($: EngineInterface, text: string, surface: RenderSurface) {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `已複製 ${lineCount(text)} 行` : `沒有複製：${copied.reason}`)
}

// Right after expanding, the heading is not drawn yet and scroll is rejected; retry after the redraw, for up to half a second.
export async function scrollTo($: EngineInterface, key: string, site?: string) {
  for (let tries = 0; tries < 10; tries++) {
    const moved = await $.ui.scroll({ to: { key }, block: 'start', ...(site ? { in: site } : {}) })
    if (!('deny' in moved) || moved.deny === undefined) return
    await $.clock.sleep(50)
  }
}
