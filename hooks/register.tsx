import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Line } from './ansi'
import { cleanSelection, isScreenCopy, sourceSlice } from './copy'
import { FOLD_LINES, cardifyTables, codeBlocks, fold, headings, lineCount, plainTitle } from './format'
import { registerFocus } from './focus'
import { extractImages } from './images'
import { registerPane } from './pane'
import {
  PANE,
  copy,
  drawLines,
  isDarkTheme,
  loadColorMode,
  loadPictures,
  opener,
  places,
  plainLine,
  renderGeneration,
  renderWithLeaf,
  scrollTo,
  setColorMode,
  watchTheme,
} from './render'
import type { DrawOptions, Elements, Pictures } from './render'
import { registerTools } from './tools'
import { openInViewer } from './viewer'
import type { FormatLevel, ImageRef, ReaderDoc } from '../types'
const isFoldOn = atom({ plugin: 'readable-chat', key: 'isFoldOn' } as const, true)
const isExpanded = atom({ plugin: 'readable-chat', key: 'isExpanded' } as const, false)
const settled = atom({ plugin: 'readable-chat', key: 'settled' } as const, [])
const history = atom({ plugin: 'readable-chat', key: 'history' } as const, [])
const pinned = atom({ plugin: 'readable-chat', key: 'pinned' } as const, [])
const selected = atom({ plugin: 'readable-chat', key: 'selected' } as const, null)
const formatLevel = atom({ plugin: 'readable-chat', key: 'formatLevel' } as const, 'more')
// Declared again in each file that reads it: the state scan only follows atoms made in a const of the same file.
const isFocusOn = atom({ plugin: 'readable-chat', key: 'isFocusOn' } as const, true)
const isRemoteImagesOn = atom({ plugin: 'readable-chat', key: 'isRemoteImagesOn' } as const, false)
const shownSource = atom({ plugin: 'readable-chat', key: 'shownSource' } as const, [])

// Length of the reader pane's list; pinned entries do not count toward it.
const HISTORY_SIZE = 10

// Fold when leaf's rendered output exceeds this many rows. leaf draws table borders and heading underlines, so it is taller than the raw markdown; hence looser than FOLD_LINES.
const FOLD_ROWS = 60

// The transcript gives the bullet two columns on the left; one column stays free on the right so a line that exactly reaches the edge does not wrap.
const BULLET = 2

// Formatting rules the model reads. They live on the session side because the text exists only in this mod.
// Phrased as what to do rather than what not to do, per Anthropic's guidance; the sentences-per-paragraph and conclusion-as-heading rules come from NN/g research on chat and long-form text.
// 「**重點**：」 (the "key point:" label) is the marker fold() in format.ts uses to find the summary; change both together.
// Both levels: mermaid blocks are drawn as images, so a chart reads better than bars spelled out in █ characters.
const CHART_RULE = '- 比較數字或呈現趨勢時，用 mermaid 的 `xychart-beta`（長條、折線）或 `pie` 區塊畫圖，數字寫在圖的資料裡。'

const RULES: Record<Exclude<FormatLevel, 'off'>, readonly string[]> = {
  more: [
    '- 回覆超過 20 行時，第一段以「**重點**：」開頭，用 1 到 2 句寫結論。做不到或有限制時，第一句就講。',
    '- 用 `##` 標題分段，標題寫出這段的結論，例如「快取讓重畫不用再開 process」，而不是「背景」「說明」這類標籤。',
    '- 每段 2 到 3 句。並列的事項用列點，一點一行。',
    '- 表格最多 4 欄，每格 20 字以內。欄位更多時寫成分組列表：每組一行粗體標題，底下一行一個「欄名：值」。',
    CHART_RULE,
  ],
  less: [
    '- 回覆超過 20 行時，第一段以「**重點**：」開頭，用 1 到 2 句寫結論。',
    '- 以段落為主，每段 2 到 3 句；只有真的並列的項目才用列點，超過 40 行的回覆才用 `##` 標題。',
    '- 表格最多 4 欄，每格 20 字以內。',
    CHART_RULE,
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

// 「放大」: the desktop's own image viewer opens the picture; only a failure needs a word.
async function zoomIn($: EngineInterface, ref: ImageRef) {
  const reason = await openInViewer($, ref, await isDarkTheme($))
  $.ui.toast(reason === null ? '已用系統看圖程式開啟' : `沒有開啟：${reason}`)
}

// Ids of rendered replies. Submitting a new prompt writes them all into settled, and only then do they fold; after a reload they accumulate again.
const seen = new Set<string>()

// Markdown source of the replies drawn since the last reload, by request id, newest last, for /copy-clean to copy from.
const sources = new Map<string, string>()
const SOURCES_SIZE = 50

function rememberSource(requestId: string, source: string) {
  sources.delete(requestId)
  sources.set(requestId, source)
  if (sources.size > SOURCES_SIZE) sources.delete(sources.keys().next().value ?? '')
}

// The selection's own reply first, then the others newest first; the rendered text cleaned up when no source matches.
function copyableText(selected: { text: string; requestId?: string }): { text: string; isSource: boolean } {
  const own = selected.requestId === undefined ? undefined : sources.get(selected.requestId)
  const candidates = [...(own === undefined ? [] : [own]), ...[...sources.values()].reverse()]
  for (const source of candidates) {
    const slice = sourceSlice(selected.text, source)
    if (slice) return { text: slice, isSource: true }
  }
  return { text: cleanSelection(selected.text), isSource: false }
}

// Copy on select writes the screen text straight to the clipboard, past every hook, and so does a multiplexer (herdr's
// copy_on_select, tmux) when the mouse is released. For GUARD_POLLS polls after the selection last changed, a clipboard
// holding that screen text gets the matching source written over it, so a plain mouse selection pastes as markdown.
// Anything else on the clipboard is left alone: a selection left on screen changes its text as the transcript scrolls or
// redraws, and writing on every change overwrote a screenshot or a copy from another app taken since.
// Without wl-paste the clipboard cannot be read; the source is then copied when the selection changes and once more
// RECOPY_MS later, after the engine's own copy has landed. No toast either way: a selection being dragged changes on
// every poll, so one would pop up again and again.
const SELECTION_POLL_MS = 250
const RECOPY_MS = 600
const GUARD_POLLS = 20
let selectionWatch: { cancel: () => void } | undefined
let themeWatch: { cancel: () => void } | undefined
let lastSelection: string | undefined
let pending: { selected: string; text: string; polls: number } | undefined
let canReadClipboard: boolean | undefined

async function copySelectionSource($: EngineInterface) {
  const selected = await $.ui.selection().catch(() => undefined)
  if (selected === undefined || selected.text.trim() === '') {
    lastSelection = undefined
    pending = undefined
    return
  }
  if (selected.text !== lastSelection) {
    lastSelection = selected.text
    pending = undefined
    // A word or a phrase inside one line is wanted exactly as seen; source markup such as `/colors` in backticks only
    // gets in the way there. Only a selection over several lines has wrap breaks and lost list markers worth replacing.
    if (!selected.text.trim().includes('\n')) return
    const { text, isSource } = copyableText(selected)
    if (!isSource || text === selected.text) return
    pending = { selected: selected.text, text, polls: GUARD_POLLS }
    canReadClipboard ??= (await $.process.run(['wl-paste', '--version'], { timeoutMs: 500 }).catch(() => null))?.exitCode === 0
    if (!canReadClipboard) {
      await $.ui.copy({ text })
      $.clock.after(RECOPY_MS, async () => {
        const still = await $.ui.selection().catch(() => undefined)
        if (still?.text === selected.text) await $.ui.copy({ text })
      })
      return
    }
  }
  if (pending === undefined || !canReadClipboard || pending.polls-- <= 0) return
  const { text } = pending
  // An image-only clipboard has no text type, so wl-paste exits non-zero and nothing is written.
  const clipboard = await $.process.run(['wl-paste', '--no-newline', '--type', 'text'], { timeoutMs: 500 }).catch(() => null)
  if (clipboard?.exitCode !== 0 || clipboard.stdout === text || !isScreenCopy(clipboard.stdout, pending.selected)) return
  await $.ui.copy({ text })
}

// A reply is drawn again on every scroll, hover and redraw, though its text rarely changed. For a long reply, re-deriving
// everything from the source and rebuilding thousands of elements took about 25 ms a time, so each reply keeps what it
// drew last, by request id, and reuses it while the inputs are the same. Scrolling changes only the sticky heading, which
// is drawn fresh each time on top of the kept body.
const DRAWN_SIZE = 300
type Derived = {
  source: string
  width: number
  generation: number
  extracted: ReturnType<typeof extractImages>
  full: Line[] | null
  titles: string[]
  codes: string[]
  isLong: boolean
}
type Kept = {
  derived?: Derived
  pictures?: { key: string; derived: Derived; value: Pictures }
  drawn?: { derived: Derived; pictures: Pictures | undefined; key: string; value: RenderChildren }
}
const kept = new Map<string, Kept>()

function keptFor(requestId: string): Kept {
  let entry = kept.get(requestId)
  if (entry) return entry
  entry = {}
  if (kept.size >= DRAWN_SIZE) kept.delete(kept.keys().next().value ?? '')
  kept.set(requestId, entry)
  return entry
}

async function derive($: EngineInterface, entry: Kept, source: string, width: number): Promise<Derived> {
  const hit = entry.derived
  if (hit && hit.source === source && hit.width === width && hit.generation === renderGeneration()) return hit
  // leaf drops `![alt](src)` to its alt text, so images become readable-image fences first; leaf frames them and drawLines swaps in the picture.
  const extracted = extractImages(source, places)
  const generation = renderGeneration()
  const full = await renderWithLeaf($, extracted.text, width)
  const derived: Derived = {
    source,
    width,
    generation,
    extracted,
    full,
    titles: headings(source),
    codes: codeBlocks(source),
    isLong: full ? full.length > FOLD_ROWS : lineCount(cardifyTables(source, width)) > FOLD_LINES,
  }
  entry.derived = derived
  return derived
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
  registerFocus(on)
  registerPane(on)

  on('session.start', async ($, e, next) => {
    places.cwd = e.cwd
    const home = await $.process.run(['printenv', 'HOME']).catch(() => null)
    if (home?.exitCode === 0) places.home = home.stdout.trim()
    // A name the engine later takes as a built-in is refused with a throw; register each on its own so one refusal
    // does not leave the commands after it unregistered.
    const commands = [
      { name: 'reader', description: '在旁邊的面板打開最近一則回覆' },
      { name: 'fold', description: '切換長回覆自動折疊' },
      { name: 'copy-clean', description: '複製滑鼠選取的文字，去掉框線、行號和折行（要全螢幕模式）' },
      {
        name: 'format',
        description: '切換注入的排版規則：more 多用標題列點、less 少用格式、off 不注入',
        argumentHint: 'more | less | off',
      },
      { name: 'focus-mode', description: '切換專注模式：舊回合變暗、隱藏回合耗時和 Skill 載入列、提問上方加分隔線' },
      { name: 'reader-colors', description: '切換回覆配色：system 跟 Omarchy 主題走、leaf 用 leaf 自己的配色', argumentHint: 'system | leaf' },
      {
        name: 'images',
        description: '顯示圖片設定；remote on | off 切換是否下載回覆裡的 https 圖片（預設關）',
        argumentHint: 'remote on | off',
      },
    ]
    for (const command of commands) await $.command.register(command).catch(() => undefined)
    await loadColorMode($).catch(() => undefined)
    selectionWatch?.cancel()
    lastSelection = undefined
    selectionWatch = $.clock.every(SELECTION_POLL_MS, () => void copySelectionSource($))
    themeWatch?.cancel()
    themeWatch = watchTheme($, places.home)

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

  on('command.run', { command: 'images' }, async ($, e) => {
    const match = /^remote\s+(on|off)$/.exec(e.args.trim())
    if (!match) {
      const isOn = await read($, isRemoteImagesOn)
      return { text: `遠端圖片：${isOn ? '開' : '關'}。用法：/images remote on | off` }
    }
    const isOn = await update($, isRemoteImagesOn, () => match[1] === 'on')

    return { text: isOn ? '遠端圖片：開，回覆裡的 https 圖片會下載後顯示。' : '遠端圖片：關，只顯示替代文字和網址。' }
  })

  on('command.run', { command: 'reader-colors' }, async ($, e) => {
    const asked = e.args.trim()
    const current = await loadColorMode($)
    const mode = asked === 'leaf' || asked === 'system' ? asked : asked === '' ? (current === 'leaf' ? 'system' : 'leaf') : null
    if (mode === null) return { text: `回覆配色：${current === 'leaf' ? 'leaf' : '跟系統'}。用法：/reader-colors system | leaf` }
    await setColorMode($, mode)

    return { text: mode === 'leaf' ? '回覆配色：leaf 自己的配色。' : '回覆配色：跟 Omarchy 主題走。' }
  })

  on('command.run', { command: 'copy-clean' }, async $ => {
    const selected = await $.ui.selection()
    if (selected === undefined || selected.text.trim() === '') {
      return { text: '沒有選取的文字。先用滑鼠選一段（要全螢幕模式），再打 /copy-clean。' }
    }
    const { text, isSource } = copyableText(selected)
    const copied = await $.ui.copy({ text })
    const from = isSource ? '原文' : '畫面（找不到對應的原文）'

    return { text: copied.isCopied ? `已從${from}複製 ${lineCount(text)} 行。` : `沒有複製：${copied.reason}` }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)

    const source = e.props.text
    rememberSource(e.requestId, source)
    const columns = e.viewport?.columns ?? 80
    const width = columns - BULLET - 1
    const entry = keptFor(e.requestId)
    const derived = await derive($, entry, source, width)
    const { extracted, full, titles, codes, isLong } = derived
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const elements: Elements = { Box, Button, Link, Text, ...('Image' in table ? { Image: table.Image } : {}) }
    const headingKey = (index: number) => `h:${e.requestId}:${index}`
    const options: DrawOptions = {
      open: opener($, e.viewport?.isFullscreen),
      copyCode: index => copy($, codes[index] ?? '', e.surface),
      headingKeys: { titles, key: headingKey },
      keyPrefix: `${e.requestId}:`,
    }
    // The body of an unfolded or opened reply, kept while the reply, its pictures and the way it is drawn stay the same.
    const drawBody = (): RenderChildren => {
      const key = `${e.viewport?.isFullscreen ?? false}|${options.dimScope ?? ''}|${e.surface}`
      const hit = entry.drawn
      if (hit && hit.derived === derived && hit.pictures === options.pictures && hit.key === key) return hit.value
      const value = draw(full, source, options)
      entry.drawn = { derived, pictures: options.pictures, key, value }
      return value
    }
    const draw = (lines: readonly Line[] | null, text: string, drawOptions: DrawOptions) =>
      lines ? (
        drawLines(elements, lines, drawOptions)
      ) : (
        <Markdown text={cardifyTables(text, width)} dimColor={drawOptions.dimScope !== undefined} />
      )

    seen.add(e.requestId)
    const isSettled = (await read($, settled)).includes(e.requestId)
    const isFolding = isLong && isSettled && (await read($, isFoldOn))
    if (isSettled && (await read($, isFocusOn))) options.dimScope = `dim:${e.requestId}`

    // When leaf is unavailable and there is nothing to fold or dim, hand back to the engine to draw, replacing only tables that do not fit.
    if (!full && !isFolding && !options.dimScope) {
      const text = cardifyTables(source, width)
      return text === source ? next(e) : next({ ...e, props: { ...e.props, text } })
    }

    const expanded = memberOf(isExpanded, e)
    const isOpen = isFolding && (await read($, expanded))
    const toggle = () => update($, expanded, open => !open)

    // Folded replies draw only the summary, so their pictures are not loaded at all.
    if (full && (!isFolding || isOpen)) {
      const shown = await read($, shownSource)
      const sourceKey = (id: string) => `${e.requestId}:${id}`
      const allowRemote = await read($, isRemoteImagesOn)
      const mine = shown.filter(key => key.startsWith(`${e.requestId}:`)).join(' ')
      const picturesKey = [renderGeneration(), width, e.surface, allowRemote, mine].join('|')
      let pictures = entry.pictures
      if (pictures?.key !== picturesKey || pictures.derived !== derived) {
        pictures = {
          key: picturesKey,
          derived,
          value: {
            ...(await loadPictures($, extracted.text, extracted.images, {
              columns: width,
              surface: e.surface,
              allowRemote,
              isSource: id => shown.includes(sourceKey(id)),
            })),
            toggleSource: id =>
              update($, shownSource, list => {
                const key = sourceKey(id)
                return list.includes(key) ? list.filter(one => one !== key) : [...list, key].slice(-200)
              }),
            zoom: ref => zoomIn($, ref),
          },
        }
        entry.pictures = pictures
      }
      options.pictures = pictures.value
    }
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
          {drawBody()}
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
          {drawBody()}
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

    // Text lights its group only where it has glyphs; the whole row of the reply joins the group too,
    // so the pointer on the blank space right of a short line or in the bullet column also counts as over the reply.
    return (
      <Box flexDirection="row" {...(options.dimScope ? { hover: { scope: options.dimScope } } : {})}>
        <Box width={BULLET} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
      </Box>
    )
  })
}
