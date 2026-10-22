import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, ElementTable, Register, RenderSurface } from 'claude-code'

import { parseAnsi } from './ansi'
import type { Line } from './ansi'
import { cleanSelection } from './copy'
import { FOLD_LINES, cardifyTables, codeBlocks, fold, headings, lineCount, mermaidBlocks, plainTitle } from './format'
import { linkify } from './links'
import { renderMermaid } from './mermaid'
import type { MermaidImage } from './mermaid'
import { registerTools } from './tools'
import type { Places } from './links'
import type { FormatLevel, ReaderDoc } from '../types'

const PANE = 'reader'
const isFoldOn = atom({ plugin: 'readable-chat', key: 'isFoldOn' } as const, true)
const isExpanded = atom({ plugin: 'readable-chat', key: 'isExpanded' } as const, false)
const settled = atom({ plugin: 'readable-chat', key: 'settled' } as const, [])
const history = atom({ plugin: 'readable-chat', key: 'history' } as const, [])
const pinned = atom({ plugin: 'readable-chat', key: 'pinned' } as const, [])
const selected = atom({ plugin: 'readable-chat', key: 'selected' } as const, null)
const formatLevel = atom({ plugin: 'readable-chat', key: 'formatLevel' } as const, 'more')

// Length of the reader pane's list; pinned entries do not count toward it.
const HISTORY_SIZE = 10

// Fold when leaf's rendered output exceeds this many rows. leaf draws table borders and heading underlines, so it is taller than the raw markdown; hence looser than FOLD_LINES.
const FOLD_ROWS = 60

// The transcript gives the bullet two columns on the left; one column stays free on the right so a line that exactly reaches the edge does not wrap.
const BULLET = 2

// Formatting rules the model reads. They live on the session side because the text exists only in this mod.
// Phrased as what to do rather than what not to do, per Anthropic's guidance; the sentences-per-paragraph and conclusion-as-heading rules come from NN/g research on chat and long-form text.
// 「**重點**：」 (the "key point:" label) is the marker fold() in format.ts uses to find the summary; change both together.
const RULES: Record<Exclude<FormatLevel, 'off'>, readonly string[]> = {
  more: [
    '- 回覆超過 20 行時，第一段以「**重點**：」開頭，用 1 到 2 句寫結論。做不到或有限制時，第一句就講。',
    '- 用 `##` 標題分段，標題寫出這段的結論，例如「快取讓重畫不用再開 process」，而不是「背景」「說明」這類標籤。',
    '- 每段 2 到 3 句。並列的事項用列點，一點一行。',
    '- 表格最多 4 欄，每格 20 字以內。欄位更多時寫成分組列表：每組一行粗體標題，底下一行一個「欄名：值」。',
  ],
  less: [
    '- 回覆超過 20 行時，第一段以「**重點**：」開頭，用 1 到 2 句寫結論。',
    '- 以段落為主，每段 2 到 3 句；只有真的並列的項目才用列點，超過 40 行的回覆才用 `##` 標題。',
    '- 表格最多 4 欄，每格 20 字以內。',
  ],
}

function formatRules(level: FormatLevel) {
  if (level === 'off') return null
  return {
    id: 'readable-chat:format',
    scope: 'session',
    text: ['# 終端機排版', '回覆會顯示在寬度有限的終端機裡，照下面排版：', ...RULES[level]].join('\n'),
  } as const
}

// Name shown in the pane list: the first heading, or the first line if there is none, at most 24 characters.
function docTitle(text: string): string {
  const title = headings(text)[0] ?? text.split('\n').find(line => line.trim() !== '') ?? '（空白）'
  const plain = plainTitle(title.replace(/^\*\*重點\*\*[:：]\s*/, ''))
  return plain.length > 24 ? `${plain.slice(0, 24)}…` : plain
}

// The same text gets the same id, so saving it once from the button and once from turn.complete does not duplicate it.
function docId(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `d${(hash >>> 0).toString(36)}`
}

async function remember($: EngineInterface, text: string): Promise<string> {
  const doc: ReaderDoc = { id: docId(text), title: docTitle(text), text }
  await update($, history, list => [doc, ...list.filter(one => one.id !== doc.id)].slice(0, HISTORY_SIZE))
  await update($, selected, () => doc.id)
  return doc.id
}

// Ids of rendered replies. Submitting a new prompt writes them all into settled, and only then do they fold; after a reload they accumulate again.
const seen = new Set<string>()

// The same message comes in again while streaming and on every redraw; leaf takes about 4 ms per run, and the cache keeps redraws from spawning another process.
// null means leaf could not run; fall back to the engine's own markdown in that case.
const rendered = new Map<string, Line[] | null>()

// Relative paths and `~/` must become absolute file:// URLs to be clickable; filled in at session.start.
const places: Places = { cwd: '.', home: '~' }

// leaf's colors follow the Omarchy theme: bin/leaf-theme.sh generates a TOML file from the current theme and prints the arguments to pass to leaf.
// Checked every 30 seconds; when the theme file changes, rendered is cleared so output in old colors does not stay in the cache.
const THEME_REFRESH_MS = 30_000
const theme = { args: [] as string[], stamp: '', checkedAt: -Infinity, isDark: true }

// If the theme cannot be read, use leaf's default colors; a theme problem must not block rendering the whole reply.
async function themeArgs($: EngineInterface): Promise<readonly string[]> {
  try {
    return await refreshTheme($)
  } catch {
    return theme.args
  }
}

async function refreshTheme($: EngineInterface): Promise<readonly string[]> {
  const now = await $.clock.now()
  if (now - theme.checkedAt < THEME_REFRESH_MS) return theme.args
  theme.checkedAt = now
  const run = await $.process.run(['bash', `${$.plugin.root}/bin/leaf-theme.sh`], { timeoutMs: 5000 }).catch(() => null)
  const args = run?.exitCode === 0 ? run.stdout.split('\n').filter(line => line !== '') : []
  const file = args[args.indexOf('--theme') + 1]
  const stat = file ? await $.process.run(['stat', '-c', '%Y', file]).catch(() => null) : null
  const stamp = `${args.join(' ')} ${stat?.stdout.trim() ?? ''}`
  if (stamp !== theme.stamp) {
    rendered.clear()
    // leaf-theme.sh uses arctic as the base for light themes; mermaid diagrams switch to light as well.
    const base = file ? await $.process.run(['grep', '-q', 'arctic', file]).catch(() => null) : null
    theme.isDark = base?.exitCode !== 0
  }
  theme.args = args
  theme.stamp = stamp
  return args
}

// Before sending to leaf, turn tables that do not fit into cards: leaf only wraps inside cells, so with many columns each cell is left with a few characters.
async function renderWithLeaf($: EngineInterface, source: string, width: number): Promise<Line[] | null> {
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
  if (rendered.size >= 300) rendered.delete(rendered.keys().next().value ?? '')
  rendered.set(key, lines)
  return lines
}

type Opener = (file: NonNullable<Line[number]['file']>) => Promise<unknown>

type Elements = Pick<ElementTable, 'Box' | 'Button' | 'Link' | 'Text'> & { Image?: ElementTable<'terminal'>['Image'] }

type DrawOptions = {
  // In fullscreen, clicks are reported to the mod: file paths are drawn as a plain Button handled by open; without it, as a file:// Link.
  open?: Opener
  // A copy button to the right of each code block's frame, copying the raw text of block n.
  copyCode?: (index: number) => Promise<unknown>
  // Each heading line is wrapped in a keyed Box so outline and table-of-contents buttons can scroll to it with $.ui.scroll.
  headingKeys?: { titles: readonly string[]; key: (index: number) => string }
  // Rendered image for mermaid block n; null or missing keeps leaf's ASCII diagram.
  mermaid?: readonly (MermaidImage | null)[]
  keyPrefix: string
}

const MERMAID_TOP = /^┌─ mermaid /
const FRAME_BOTTOM = /^└─*┘$/

// Draw kitty images only on the terminal; blocks that fail to render keep leaf's ASCII.
async function mermaidImages($: EngineInterface, source: string, columns: number, surface: RenderSurface) {
  if (surface !== 'terminal') return []
  const blocks = mermaidBlocks(source)
  if (blocks.length === 0) return []
  await themeArgs($)
  return Promise.all(blocks.map(code => renderMermaid($, code, { columns, isDark: theme.isDark, maxRows: 25 }).catch(() => null)))
}

const CODE_TOP = /^┌─/
const CODE_FIRST_LINE = /^│\s*\d+│/

function plainLine(line: Line): string {
  return line.map(span => span.text).join('').trim()
}

function drawSpans({ Button, Link, Text }: Elements, line: Line, row: number, options: DrawOptions) {
  const { open } = options
  if (open && line.some(span => span.file)) {
    return line.map((span, i) => {
      const file = span.file
      return file ? (
        <Button key={`${options.keyPrefix}open:${row}:${i}`} plain onPress={() => open(file)}>
          <Text {...span.style}>{span.text}</Text>
        </Button>
      ) : (
        <Text {...span.style}>{span.text}</Text>
      )
    })
  }
  return [
    <Text wrap="truncate">
      {line.map(span =>
        span.href ? (
          <Link href={span.href}>
            <Text {...span.style}>{span.text}</Text>
          </Link>
        ) : (
          <Text {...span.style}>{span.text}</Text>
        ),
      )}
    </Text>,
  ]
}

function drawLines(elements: Elements, lines: readonly Line[], options: DrawOptions) {
  const { Box, Button, Image, Text } = elements
  let code = 0
  let heading = 0
  let diagram = 0
  const rows = []
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? []
    if (line.length === 0) {
      rows.push(<Text> </Text>)
      continue
    }
    const plain = plainLine(line)

    // Replace leaf's whole mermaid frame with the image and skip to the frame's bottom line.
    if (MERMAID_TOP.test(plain)) {
      const image = options.mermaid?.[diagram++]
      if (image && Image) {
        rows.push(<Image source={image.source} columns={image.columns} rows={image.rows} alt={image.alt} />)
        while (row + 1 < lines.length && !FRAME_BOTTOM.test(plainLine(lines[row] ?? []))) row++
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

function opener($: EngineInterface, isFullscreen: boolean | undefined): Opener | undefined {
  if (isFullscreen !== true) return undefined
  return file =>
    $.process.run(
      ['bash', `${$.plugin.root}/bin/open-in-nvim.sh`, file.path, ...(file.line ? [String(file.line)] : [])],
      { timeoutMs: 10000 },
    )
}

async function copy($: EngineInterface, text: string, surface: RenderSurface) {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `已複製 ${lineCount(text)} 行` : `沒有複製：${copied.reason}`)
}

// Right after expanding, the heading is not drawn yet and scroll is rejected; retry after the redraw, for up to half a second.
async function scrollTo($: EngineInterface, key: string, site?: string) {
  for (let tries = 0; tries < 10; tries++) {
    const moved = await $.ui.scroll({ to: { key }, block: 'start', ...(site ? { in: site } : {}) })
    if (!('deny' in moved) || moved.deny === undefined) return
    await $.clock.sleep(50)
  }
}

// The last heading already scrolled off screen, and the row to draw it on (the first visible row).
// Each leaf line is one row in the tree, so a heading's line index is its row index.
function stickyHeading(
  lines: readonly Line[],
  titles: readonly string[],
  onScreen: { first: number; last: number; of: number } | null | undefined,
): { row: number; title: string } | null {
  if (!onScreen || onScreen.first <= 0 || onScreen.first >= lines.length) return null
  let found: string | null = null
  let next = 0
  for (let row = 0; row < onScreen.first && next < titles.length; row++) {
    if (plainLine(lines[row] ?? []) === titles[next]) found = titles[next++] ?? null
  }
  return found ? { row: onScreen.first, title: found } : null
}

export const register: Register = on => {
  registerTools(on)

  on('session.start', async ($, e, next) => {
    places.cwd = e.cwd
    const home = await $.process.run(['printenv', 'HOME']).catch(() => null)
    if (home?.exitCode === 0) places.home = home.stdout.trim()
    await $.command.register({
      name: 'reader',
      description: '在旁邊的面板打開最近一則回覆',
    })
    await $.command.register({
      name: 'fold',
      description: '切換長回覆自動折疊',
    })
    await $.command.register({
      name: 'copy-clean',
      description: '複製滑鼠選取的文字，去掉框線、行號和折行（要全螢幕模式）',
    })
    await $.command.register({
      name: 'format',
      description: '切換注入的排版規則：more 多用標題列點、less 少用格式、off 不注入',
      argumentHint: 'more | less | off',
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const rules = formatRules(await read($, formatLevel))

    return { sections: rules ? [...sections, rules] : sections }
  })

  // On prompt submit, every reply on screen becomes "old" and folds on the next redraw; the latest one folds only once it finishes and is pushed up.
  on('prompt.submit', async ($, e, next) => {
    if (seen.size > 0) {
      await update($, settled, list => [...new Set([...list, ...seen])].slice(-500))
    }

    return next(e)
  })

  // Every reply goes into the reader pane's list.
  on('turn.complete', async ($, e, next) => {
    if (e.answer.trim() !== '') await remember($, e.answer)

    return next(e)
  })

  on('command.run', { command: 'reader' }, async $ => {
    if ((await read($, history)).length === 0 && (await read($, pinned)).length === 0) {
      return { text: '還沒有回覆可以放進面板。' }
    }
    const opened = await $.ui.open({ id: PANE, title: '閱讀' })

    return { text: opened.isPlaced ? '閱讀面板已打開。' : `面板沒有顯示：${opened.reason}` }
  })

  on('command.run', { command: 'fold' }, async $ => {
    const isOn = await update($, isFoldOn, isOn => !isOn)

    return { text: isOn ? '長回覆自動折疊：開' : '長回覆自動折疊：關' }
  })

  on('command.run', { command: 'format' }, async ($, e) => {
    const level = e.args.trim()
    if (level !== 'more' && level !== 'less' && level !== 'off') {
      return { text: `排版規則目前是 ${await read($, formatLevel)}。用法：/format more | less | off` }
    }
    await update($, formatLevel, () => level)

    return { text: `排版規則：${level}，下一則回覆開始套用。` }
  })

  on('command.run', { command: 'copy-clean' }, async $ => {
    const selected = await $.ui.selection()
    if (selected === undefined || selected.text.trim() === '') {
      return { text: '沒有選取的文字。先用滑鼠選一段（要全螢幕模式），再打 /copy-clean。' }
    }
    const text = cleanSelection(selected.text)
    const copied = await $.ui.copy({ text })

    return { text: copied.isCopied ? `已複製 ${lineCount(text)} 行。` : `沒有複製：${copied.reason}` }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)

    const source = e.props.text
    const columns = e.viewport?.columns ?? 80
    const width = columns - BULLET - 1
    const full = await renderWithLeaf($, source, width)
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const elements: Elements = { Box, Button, Link, Text, ...('Image' in table ? { Image: table.Image } : {}) }
    const titles = headings(source)
    const codes = codeBlocks(source)
    const headingKey = (index: number) => `h:${e.requestId}:${index}`
    const options: DrawOptions = {
      open: opener($, e.viewport?.isFullscreen),
      copyCode: index => copy($, codes[index] ?? '', e.surface),
      headingKeys: { titles, key: headingKey },
      mermaid: await mermaidImages($, source, width, e.surface),
      keyPrefix: `${e.requestId}:`,
    }
    const draw = (lines: readonly Line[] | null, text: string, drawOptions: DrawOptions) =>
      lines ? drawLines(elements, lines, drawOptions) : <Markdown text={cardifyTables(text, width)} />

    const isLong = full ? full.length > FOLD_ROWS : lineCount(cardifyTables(source, width)) > FOLD_LINES
    seen.add(e.requestId)
    const isSettled = (await read($, settled)).includes(e.requestId)
    const isFolding = isLong && isSettled && (await read($, isFoldOn))

    // When leaf is unavailable and no folding is needed, hand back to the engine to draw, replacing only tables that do not fit.
    if (!full && !isFolding) {
      const text = cardifyTables(source, width)
      return text === source ? next(e) : next({ ...e, props: { ...e.props, text } })
    }

    const expanded = memberOf(isExpanded, e)
    const isOpen = isFolding && (await read($, expanded))
    const toggle = () => update($, expanded, open => !open)
    const copyAll = () => copy($, source, e.surface)
    const openPane = async () => {
      await remember($, source)
      await $.ui.open({ id: PANE, title: '閱讀' })
    }

    // When the top of the reply scrolls off screen, pin the current heading to the top visible row.
    const sticky = full && (!isFolding || isOpen) ? stickyHeading(full, titles, e.props.onScreen) : null
    const stickyBox = sticky && (
      <Box position="absolute" top={sticky.row} left={0}>
        <Text inverse> ▸ {sticky.title} </Text>
      </Box>
    )

    let body
    if (!isFolding) {
      // Unfolded replies get no button row: a copy button appears in the top-right corner only on mouse hover.
      body = (
        <Box key={`${e.requestId}:msg`} flexDirection="column">
          {draw(full, source, options)}
          {stickyBox}
          <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
            <Button key={`${e.requestId}:copy`} plain onPress={copyAll}>
              <Text dimColor>⧉ 複製</Text>
            </Button>
          </Box>
        </Box>
      )
    } else if (isOpen) {
      body = (
        <Box flexDirection="column">
          {draw(full, source, options)}
          {stickyBox}
          <Box>
            <Button key="collapse" label="收合" onPress={toggle} />
            <Text> </Text>
            <Button key="copy" label="複製原文" onPress={copyAll} />
          </Box>
        </Box>
      )
    } else {
      const folded = fold(source)
      const lines = folded.summary === '' ? [] : await renderWithLeaf($, folded.summary, width)
      // Each outline item is a button: expand this reply, then scroll to that heading.
      const jump = async (index: number) => {
        await update($, expanded, () => true)
        await scrollTo($, headingKey(index))
      }
      body = (
        <Box flexDirection="column">
          {folded.summary !== '' && draw(lines, folded.summary, { ...options, headingKeys: undefined })}
          {folded.outline.map((title, index) => (
            <Button key={`outline:${index}`} plain onPress={() => jump(index)}>
              <Text dimColor>  ▸ </Text>
              <Text>{title}</Text>
            </Button>
          ))}
          <Box>
            <Text dimColor>（折疊了 {(full?.length ?? lineCount(source)) - (lines?.length ?? 0)} 行） </Text>
            <Button key="expand" label="展開" variant="primary" onPress={toggle} />
            <Text> </Text>
            <Button key="pane" label="在面板讀" onPress={openPane} />
            <Text> </Text>
            <Button key="copy" label="複製原文" onPress={copyAll} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Box width={BULLET} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const Image = 'Image' in table ? table.Image : undefined
    const pins = await read($, pinned)
    const recent = (await read($, history)).filter(doc => !pins.some(pin => pin.id === doc.id))
    const chosen = await read($, selected)
    const docs = [...pins, ...recent]
    const doc = docs.find(one => one.id === chosen) ?? docs[0]
    if (doc === undefined) return <Text dimColor>還沒有回覆。</Text>

    const isPinned = pins.some(pin => pin.id === doc.id)
    const togglePin = () =>
      update($, pinned, list =>
        isPinned ? list.filter(pin => pin.id !== doc.id) : [doc, ...list.filter(pin => pin.id !== doc.id)],
      )
    // List: pinned first (★), the rest newest to oldest; the current one is shown in reverse video.
    const tabs = (
      <Box flexDirection="row" flexWrap="wrap">
        {docs.map(one => (
          <Button key={`doc:${one.id}`} plain onPress={() => update($, selected, () => one.id)}>
            <Text inverse={one.id === doc.id} dimColor={one.id !== doc.id}>
              {pins.some(pin => pin.id === one.id) ? '★' : '·'} {one.title}{' '}
            </Text>
          </Button>
        ))}
        <Button key="pin" plain onPress={togglePin}>
          <Text color="yellow">{isPinned ? '[取消釘選]' : '[釘選]'}</Text>
        </Button>
      </Box>
    )

    const width = e.props.bodyColumns
    const lines = await renderWithLeaf($, doc.text, width)
    if (!lines) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Markdown text={cardifyTables(doc.text, width)} />
        </Box>
      )
    }

    const titles = headings(doc.text)
    const codes = codeBlocks(doc.text)
    const key = (index: number) => `toc:${doc.id}:${index}`
    return (
      <Box flexDirection="column">
        {tabs}
        {titles.length > 1 && (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text dimColor>目錄</Text>
            {titles.map((title, index) => (
              <Button key={`toc-link:${index}`} plain onPress={() => scrollTo($, key(index), PANE)}>
                <Text dimColor>  ▸ </Text>
                <Text>{title}</Text>
              </Button>
            ))}
          </Box>
        )}
        {drawLines({ Box, Button, Link, Text, ...(Image ? { Image } : {}) }, lines, {
          open: opener($, e.viewport?.isFullscreen),
          copyCode: index => copy($, codes[index] ?? '', e.surface),
          headingKeys: { titles, key },
          mermaid: await mermaidImages($, doc.text, width, e.surface),
          keyPrefix: `pane:${doc.id}:`,
        })}
      </Box>
    )
  })
}
