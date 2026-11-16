// The reader pane (/reader, 「在面板讀」): one saved reply at a time with its tabs, table of contents and leaf rendering,
// plus three reading aids taken from pagers and browsers: a line filter (less's `&`), keyboard labels on links (kitty hints, vimium)
// and a back stack for jumps.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ElementTable, On, RenderElement, RenderSurface } from 'claude-code'

import type { Line, Span } from './ansi'
import { cardifyTables, codeBlocks, headings } from './format'
import { extractImages } from './images'
import { linkify } from './links'
import { openInViewer } from './viewer'
import { PANE, copy, drawLines, isDarkTheme, loadPictures, openFile, opener, places, renderWithLeaf, scrollTo } from './render'
import type { Elements } from './render'
import type { ImageRef, PaneSpot, ReaderDoc } from '../types'

// Declared again in each file that reads them: the state scan only follows atoms made in a const of the same file.
const history = atom({ plugin: 'readable-chat', key: 'history' } as const, [])
const pinned = atom({ plugin: 'readable-chat', key: 'pinned' } as const, [])
const selected = atom({ plugin: 'readable-chat', key: 'selected' } as const, null)
const paneQuery = atom({ plugin: 'readable-chat', key: 'paneQuery' } as const, '')
const isHinting = atom({ plugin: 'readable-chat', key: 'isHinting' } as const, false)
const paneBack = atom({ plugin: 'readable-chat', key: 'paneBack' } as const, [])
const isRemoteImagesOn = atom({ plugin: 'readable-chat', key: 'isRemoteImagesOn' } as const, false)
const shownSource = atom({ plugin: 'readable-chat', key: 'shownSource' } as const, [])

// Enough to undo a reading session's worth of jumps without the list growing for the whole session.
const BACK_SIZE = 20

// Key of the Box around the whole pane, the scroll target for a spot with no heading.
const TOP = 'pane-top'

// Label letters, home row first as kitty and vimium order them. f and b are left out: they are the pane's own hotkeys
// (labels, back), and a label sharing one would make that key ambiguous while labels are showing.
export const HINT_KEYS = 'asdghjklqwertyuiopzxcvnm'

// The first letter of a two-letter label already pressed. Kept in the module rather than $.state: it lives for one
// keystroke, and a hot reload dropping it only cancels a half-typed label.
let hintPrefix = ''

// The heading each reply was last jumped to, so the spot pushed before the next jump says where the reader was.
// Scrolling by hand does not update it; the pane is only told its window offset, not which rows it shows.
const at = new Map<string, number | null>()

const tocKey = (docId: string, index: number) => `toc:${docId}:${index}`

// A scroll that fails outright (no surface to move) leaves the reader where they were; the selection and the back stack
// are already written by then, so the press must not fail with it.
const scrollPane = ($: EngineInterface, key: string) => scrollTo($, key, PANE).catch(() => undefined)

// Prefix-free labels for count links, as kitty's hints kitten builds them: single letters while they suffice; past that,
// the last k letters of the alphabet become prefixes of two-letter labels, with k as small as fits every link.
export function hintLabels(count: number, keys: string = HINT_KEYS): string[] {
  const letters = [...keys]
  const n = letters.length
  if (count <= n) return letters.slice(0, count)
  let k = 1
  while (k < n && n - k + k * n < count) k++
  const singles = letters.slice(0, n - k)
  const doubles = letters.slice(n - k).flatMap(first => letters.map(second => first + second))
  return [...singles, ...doubles].slice(0, count)
}

export type LinkStart = { row: number; index: number; span: Span }

// The first span of each link on screen. leaf draws one link as several spans (its `#` marker, then the underlined words,
// continuing on the next row when it wraps), all with the same href, so a run of one href is one link.
export function linkStarts(lines: readonly Line[]): LinkStart[] {
  const starts: LinkStart[] = []
  let current: string | undefined
  lines.forEach((line, row) => {
    if (line.length === 0) current = undefined
    line.forEach((span, index) => {
      if (span.href && span.href !== current) starts.push({ row, index, span })
      current = span.href
    })
  })
  return starts
}

// The line with every case-insensitive occurrence of needle drawn inverse, or null when it has none.
export function highlight(line: Line, needle: string): Line | null {
  const text = line.map(span => span.text).join('')
  const lower = text.toLowerCase()
  const hits: [number, number][] = []
  for (let from = lower.indexOf(needle); from !== -1 && needle !== ''; from = lower.indexOf(needle, from + needle.length)) {
    hits.push([from, from + needle.length])
  }
  if (hits.length === 0) return null
  // A few characters change length when lowercased (İ); offsets into the lowered text would then cut the wrong place.
  if (lower.length !== text.length) return line
  const out: Line = []
  let offset = 0
  for (const span of line) {
    const end = offset + span.text.length
    const cuts = new Set([offset, end])
    for (const [a, b] of hits) {
      if (a > offset && a < end) cuts.add(a)
      if (b > offset && b < end) cuts.add(b)
    }
    const points = [...cuts].sort((x, y) => x - y)
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] ?? 0
      const b = points[i + 1] ?? 0
      const isHit = hits.some(([x, y]) => a >= x && b <= y)
      out.push({ ...span, text: text.slice(a, b), style: isHit ? { ...span.style, inverse: true } : span.style })
    }
    offset = end
  }
  return out
}

// Without leaf the pane still filters and labels: each source line becomes one unstyled line, its URLs and paths linked.
function sourceLines(text: string): Line[] {
  const raw = text.split('\n').map(line => (line === '' ? [] : [{ text: line, style: {} }]))
  return linkify(raw, text, places)
}

function openTarget($: EngineInterface, span: Span) {
  if (span.file) return openFile($, span.file)
  // The API has no call that opens a URL; a press is all a Link reports. xdg-open is what a click on one runs here anyway.
  return $.process.run(['xdg-open', span.href ?? ''], { timeoutMs: 10000 })
}

type PaneElements = Elements & Pick<ElementTable, 'Markdown'> & { Input?: ElementTable<'terminal'>['Input'] }

type PaneView = {
  elements: PaneElements
  width: number
  isFullscreen: boolean | undefined
  surface: RenderSurface
}

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const elements: PaneElements = {
      Box,
      Button,
      Link,
      Markdown,
      Text,
      ...('Image' in table ? { Image: table.Image } : {}),
      ...('Input' in table ? { Input: table.Input } : {}),
    }
    const view: PaneView = { elements, width: e.props.bodyColumns, isFullscreen: e.viewport?.isFullscreen, surface: e.surface }

    return drawReply($, view)
  })
}

async function drawReply($: EngineInterface, view: PaneView): Promise<RenderElement> {
  const { Box, Button, Input, Markdown, Text } = view.elements
  const pins = await read($, pinned)
  const recent = (await read($, history)).filter(doc => !pins.some(pin => pin.id === doc.id))
  const chosen = await read($, selected)
  const docs: ReaderDoc[] = [...pins, ...recent]
  const doc = docs.find(one => one.id === chosen) ?? docs[0]
  if (doc === undefined) return <Text dimColor>還沒有回覆。</Text>

  const query = await read($, paneQuery)
  const needle = query.trim().toLowerCase()
  const isLabeling = await read($, isHinting)
  const back = await read($, paneBack)

  const here = (): PaneSpot => ({ docId: doc.id, heading: at.get(doc.id) ?? null })
  const pushBack = (spot: PaneSpot) => update($, paneBack, list => [...list, spot].slice(-BACK_SIZE))
  const pick = async (id: string) => {
    if (id === doc.id) return
    await pushBack(here())
    at.set(id, null)
    await update($, selected, () => id)
  }
  const jump = async (index: number) => {
    await pushBack(here())
    at.set(doc.id, index)
    await scrollPane($, tocKey(doc.id, index))
  }
  const goBack = async () => {
    const spot = (await read($, paneBack)).at(-1)
    if (spot === undefined) return
    await update($, paneBack, list => list.slice(0, -1))
    await update($, selected, () => spot.docId)
    at.set(spot.docId, spot.heading)
    await scrollPane($, spot.heading === null ? TOP : tocKey(spot.docId, spot.heading))
  }
  const toggleHints = () => {
    hintPrefix = ''
    return update($, isHinting, isOn => !isOn)
  }

  const isPinned = pins.some(pin => pin.id === doc.id)
  const togglePin = () =>
    update($, pinned, list => (isPinned ? list.filter(pin => pin.id !== doc.id) : [doc, ...list.filter(pin => pin.id !== doc.id)]))
  // List: pinned first (★), the rest newest to oldest; the current one is shown in reverse video.
  const tabs = (
    <Box flexDirection="row" flexWrap="wrap">
      {docs.map(one => (
        <Button key={`doc:${one.id}`} plain onPress={() => pick(one.id)}>
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

  const width = view.width
  const extracted = extractImages(doc.text, places)
  const lines = await renderWithLeaf($, extracted.text, width)
  const source = lines ?? (needle !== '' || isLabeling ? sourceLines(doc.text) : null)
  const shown = source && needle !== '' ? source.map(line => highlight(line, needle)).filter(line => line !== null) : source
  const matches = source && needle !== '' ? source.filter(line => highlight(line, needle) !== null).length : 0

  const setQuery = (value: string) => update($, paneQuery, () => value)
  const search = Input && (
    <Input key="pane-query" label="⌕ " placeholder="篩選這則回覆" value={query} onInput={setQuery} onSubmit={setQuery} />
  )
  const toolbar = (
    <Box flexDirection="row" flexWrap="wrap">
      {needle !== '' && <Text dimColor>{matches} 筆 </Text>}
      {query !== '' && (
        <>
          <Button key="pane-query-clear" plain label="清除" onPress={() => setQuery('')} />
          <Text>  </Text>
        </>
      )}
      <Button key="hint-toggle" plain hotkey="f" label={isLabeling ? '標籤：開' : '標籤'} onPress={toggleHints} />
      {back.length > 0 && (
        <>
          <Text>  </Text>
          <Button key="back" plain hotkey="b" label="← 返回" onPress={goBack} />
        </>
      )}
    </Box>
  )

  // Keyboard labels on the links of the lines shown, filtered or not, so each label matches something visible.
  const starts = isLabeling && shown ? linkStarts(shown) : []
  const labels = hintLabels(starts.length)
  const labelAt = new Map(starts.map((start, i) => [`${start.row}:${start.index}`, { label: labels[i] ?? '', span: start.span }]))
  const go = async (span: Span) => {
    hintPrefix = ''
    await update($, isHinting, () => false)
    await openTarget($, span)
  }
  const choosePrefix = (prefix: string) => {
    hintPrefix = prefix
    $.ui.invalidate('ui.render')
  }
  // A Button's hotkey is one key, so a two-letter label takes two presses: its first letter (a prefix button below) narrows
  // the labels to that group, then the second letter presses the label itself. A click on any label opens it directly.
  const hint = (row: number, index: number) => {
    const found = labelAt.get(`${row}:${index}`)
    if (found === undefined) return undefined
    const { label, span } = found
    const isSingle = label.length === 1
    const isInGroup = hintPrefix !== '' && label.startsWith(hintPrefix)
    if (hintPrefix !== '' && !isInGroup) return <Text dimColor>{label}</Text>
    const hotkey = hintPrefix === '' ? (isSingle ? label : undefined) : label.slice(1)
    return (
      <Button key={`hint:${label}`} plain {...(hotkey ? { hotkey } : {})} onPress={() => go(span)}>
        <Text inverse>{label}</Text>
      </Button>
    )
  }
  const prefixes = [...new Set(labels.filter(label => label.length === 2).map(label => label[0] ?? ''))]
  const hintBar =
    isLabeling &&
    (hintPrefix !== '' ? (
      <Box flexDirection="row">
        <Text dimColor>已按 {hintPrefix}，再按第二個字母 </Text>
        <Button key="hint-prefix-cancel" plain label="取消" onPress={() => choosePrefix('')} />
      </Box>
    ) : starts.length === 0 ? (
      <Text dimColor>這則回覆沒有連結或路徑。</Text>
    ) : (
      prefixes.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>兩個字母的標籤先按：</Text>
          {prefixes.map(prefix => (
            <Button key={`hint-prefix:${prefix}`} plain hotkey={prefix} label={`${prefix}…`} onPress={() => choosePrefix(prefix)} />
          ))}
        </Box>
      )
    ))

  const header = (
    <>
      {search}
      {toolbar}
      {hintBar}
      {tabs}
    </>
  )

  if (!shown) {
    return (
      <Box key={TOP} flexDirection="column">
        {header}
        <Markdown text={cardifyTables(doc.text, width)} />
      </Box>
    )
  }

  const open = opener($, view.isFullscreen)
  const drawElements = view.elements
  // A filtered list is a set of loose lines: no table of contents, no heading anchors, no code copy buttons
  // (their positions are found from neighbouring lines), no diagrams.
  if (needle !== '') {
    return (
      <Box key={TOP} flexDirection="column">
        {header}
        {shown.length === 0 ? (
          <Text dimColor>沒有符合「{query.trim()}」的行。</Text>
        ) : (
          drawLines(drawElements, shown, { ...(open ? { open } : {}), hint, keyPrefix: `pane:${doc.id}:q:` })
        )}
      </Box>
    )
  }

  // Same pictures as the transcript, at the pane's width; 「原始碼」 keys are per saved reply, apart from the transcript's.
  const docPictures = async () => {
    const shown = await read($, shownSource)
    const sourceKey = (id: string) => `pane:${doc.id}:${id}`
    return {
      ...(await loadPictures($, extracted.text, extracted.images, {
        columns: width,
        surface: view.surface,
        allowRemote: await read($, isRemoteImagesOn),
        isSource: id => shown.includes(sourceKey(id)),
      })),
      toggleSource: (id: string) =>
        update($, shownSource, list => {
          const key = sourceKey(id)
          return list.includes(key) ? list.filter(one => one !== key) : [...list, key].slice(-200)
        }),
      zoom: async (ref: ImageRef) => {
        const reason = await openInViewer($, ref, await isDarkTheme($))
        $.ui.toast(reason === null ? '已用系統看圖程式開啟' : `沒有開啟：${reason}`)
      },
    }
  }
  const titles = headings(doc.text)
  const codes = codeBlocks(doc.text)
  const key = (index: number) => tocKey(doc.id, index)
  return (
    <Box key={TOP} flexDirection="column">
      {header}
      {titles.length > 1 && (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text dimColor>目錄</Text>
          {titles.map((title, index) => (
            <Button key={`toc-link:${index}`} plain onPress={() => jump(index)}>
              <Text dimColor>  ▸ </Text>
              <Text>{title}</Text>
            </Button>
          ))}
        </Box>
      )}
      {drawLines(drawElements, shown, {
        ...(open ? { open } : {}),
        copyCode: index => copy($, codes[index] ?? '', view.surface),
        headingKeys: { titles, key },
        ...(lines ? { pictures: await docPictures() } : {}),
        hint,
        keyPrefix: `pane:${doc.id}:`,
      })}
    </Box>
  )
}
