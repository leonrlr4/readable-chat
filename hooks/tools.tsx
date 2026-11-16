import { atom, memberOf, read, update } from 'claude-code'
import type { On } from 'claude-code'

import { displayWidth } from './format'
import { loadImage } from './images'

const isToolCollapseOn = atom({ plugin: 'readable-chat', key: 'isToolCollapseOn' } as const, true)
const isToolOpen = atom({ plugin: 'readable-chat', key: 'isToolOpen' } as const, false)
// Focus mode, toggled by /focus-mode in focus.tsx.
const isFocusOn = atom({ plugin: 'readable-chat', key: 'isFocusOn' } as const, true)

// Only these collapse: their output is long and a summary is clear at a glance. Other tools (Agent, MCP, etc.) are drawn by the engine.
const COLLAPSIBLE = new Set(['Edit', 'Write', 'Bash', 'Read', 'Grep', 'Glob'])

// Two columns on the left for the bullet, aligned with the engine's tool rows.
const BULLET = 2

// Columns taken by 「  [ 展開 ]」 (the "expand" mark); the summary subtracts this much so it does not wrap.
const OPEN_MARK = '  [展開]'

// Read of one of these (by file_path extension) draws a thumbnail under its collapsed row. SVG is read as text but still drawn.
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i
// Tallest thumbnail, in rows; enough to recognize a screenshot without pushing the transcript away.
const THUMB_ROWS = 8

// For relative paths; filled in at session.start. After a hot reload, until it is filled, absolute paths are shown.
const places = { cwd: '' }

// The summary's parts: head is the action and target, added/removed are the diff's added and removed line counts, note is the parenthesized extra.
export type ToolSummary = { head: string; added?: number; removed?: number; note?: string }

type Hunk = { lines: readonly string[] }

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Each structuredPatch line starts with '+', '-' or ' '; '\' is "No newline at end of file" and is not counted.
export function countDiff(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// Line count of the text; a trailing newline does not add a line, and an empty string is 0 lines.
export function countLines(value: string): number {
  const trimmed = value.replace(/\n+$/, '')
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path)
}

function absolutePath(path: string, cwd: string): string {
  return path.startsWith('/') || cwd === '' ? path : `${cwd}/${path}`
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function shortPath(path: string, cwd: string): string {
  if (cwd !== '' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path
}

function hunksOf(output: Record<string, unknown>): Hunk[] | undefined {
  const patch = output.structuredPatch
  if (!Array.isArray(patch)) return undefined
  return patch.map(hunk => {
    const lines = record(hunk).lines
    return { lines: Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string') : [] }
  })
}

function summarizeEdit(input: Record<string, unknown>, output: Record<string, unknown>, cwd: string): ToolSummary {
  const path = shortPath(text(output.filePath) || text(input.file_path), cwd)
  const hunks = hunksOf(output)
  // When there is no result yet (old transcripts did not store structuredPatch), estimate from the line counts of old/new_string.
  const diff = hunks ?? [
    { lines: text(input.old_string).split('\n').map(line => `-${line}`) },
    { lines: text(input.new_string).split('\n').map(line => `+${line}`) },
  ]
  const { added, removed } = countDiff(diff)
  return { head: `✎ 改了 ${path}`, added, removed, ...(output.staged === true ? { note: '待審核' } : {}) }
}

function summarizeWrite(input: Record<string, unknown>, output: Record<string, unknown>, cwd: string): ToolSummary {
  const path = shortPath(text(output.filePath) || text(input.file_path), cwd)
  const content = text(output.content) || text(input.content)
  if (output.type === 'update') {
    const hunks = hunksOf(output)
    if (hunks && hunks.length > 0) return { head: `✎ 改寫 ${path}`, ...countDiff(hunks) }
    return { head: `✎ 改寫 ${path}`, note: '內容沒變' }
  }
  return { head: `✎ 新增 ${path}`, added: countLines(content) }
}

// Keep only the command's first line; a multi-line heredoc or script gets 「…」 (ellipsis) appended to show there is more.
export function firstLine(command: string): string {
  const lines = command.trim().split('\n')
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? '')
}

function summarizeBash(input: Record<string, unknown>, output: Record<string, unknown>): ToolSummary {
  const head = `$ ${firstLine(text(input.command))}`
  if (typeof output.backgroundTaskId === 'string') return { head, note: '在背景執行' }
  if (output.isImage === true) return { head, note: '輸出是圖片' }
  const lines = countLines(text(output.stdout)) + countLines(text(output.stderr))
  if (lines === 0 && !('stdout' in output)) return { head }
  return { head, note: lines === 0 ? '沒有輸出' : `輸出 ${lines} 行` }
}

function summarizeRead(input: Record<string, unknown>, output: Record<string, unknown>, cwd: string): ToolSummary {
  const file = record(output.file)
  const path = shortPath(text(file.filePath) || text(input.file_path), cwd)
  const head = `❐ 讀了 ${path}`
  switch (output.type) {
    case 'text': {
      const lines = count(file.numLines) ?? 0
      const start = count(file.startLine) ?? 1
      const total = count(file.totalLines) ?? lines
      if (lines >= total) return { head, note: `${lines} 行` }
      return { head, note: `第 ${start}–${start + Math.max(lines, 1) - 1} 行，共 ${total} 行` }
    }
    case 'image': {
      // The image result carries no filePath (the path above came from the input) and its base64 is the downscaled copy the model saw.
      const dimensions = record(file.dimensions)
      const width = count(dimensions.originalWidth)
      const height = count(dimensions.originalHeight)
      return { head, note: width !== undefined && height !== undefined ? `圖片 ${width}×${height}` : '圖片' }
    }
    case 'pdf':
      return { head, note: 'PDF' }
    case 'notebook': {
      const cells = file.cells
      return { head, note: Array.isArray(cells) ? `${cells.length} 格` : 'notebook' }
    }
    default:
      return { head }
  }
}

function summarizeGrep(input: Record<string, unknown>, output: Record<string, unknown>, cwd: string): ToolSummary {
  const where = text(input.path)
  const head = `⌕ 搜尋 ${text(input.pattern)}${where === '' ? '' : ` 於 ${shortPath(where, cwd)}`}`
  const lines = count(output.numLines)
  if (output.mode === 'content' && lines !== undefined) return { head, note: `${lines} 行符合` }
  const files = count(output.numFiles)
  if (files !== undefined) return { head, note: files === 0 ? '沒有符合' : `${files} 個檔案` }
  return { head }
}

function summarizeGlob(input: Record<string, unknown>, output: Record<string, unknown>): ToolSummary {
  const head = `⌕ 找檔案 ${text(input.pattern)}`
  const files = count(output.numFiles) ?? (Array.isArray(output.filenames) ? output.filenames.length : undefined)
  if (files === undefined) return { head }
  return { head, note: files === 0 ? '沒有符合' : `${files} 個檔案` }
}

// One-line summary for a tool call row; returns null for tools that are not collapsed.
export function summarizeTool(tool: string, input: unknown, output: unknown, cwd = ''): ToolSummary | null {
  const args = record(input)
  const result = record(output)
  switch (tool) {
    case 'Edit':
      return summarizeEdit(args, result, cwd)
    case 'Write':
      return summarizeWrite(args, result, cwd)
    case 'Bash':
      return summarizeBash(args, result)
    case 'Read':
      return summarizeRead(args, result, cwd)
    case 'Grep':
      return summarizeGrep(args, result, cwd)
    case 'Glob':
      return summarizeGlob(args, result)
    default:
      return null
  }
}

function stats(summary: ToolSummary): string {
  const parts: string[] = []
  if (summary.added !== undefined) parts.push(`+${summary.added}`)
  if (summary.removed !== undefined) parts.push(`−${summary.removed}`)
  if (summary.note !== undefined) parts.push(`（${summary.note}）`)
  return parts.join(' ')
}

// Plain-text form of the summary, used by tests and width calculation; on screen +/− are colored separately.
export function summaryText(summary: ToolSummary): string {
  const tail = stats(summary)
  return tail === '' ? summary.head : `${summary.head}  ${tail}`
}

// Truncate by display width (CJK characters count as two columns), appending 「…」 where cut.
export function clip(value: string, width: number): string {
  if (displayWidth(value) <= width) return value
  let out = ''
  for (const char of value) {
    if (displayWidth(out + char) > width - 1) break
    out += char
  }
  return `${out}…`
}

export function registerTools(on: On): void {
  // register.tsx also hooks session.start; one event cannot have two hooks without a matcher,
  // so this one registers /tools only in interactive sessions (-p and the SDK do not draw tool rows, so they do not need it).
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    places.cwd = e.cwd
    await $.command.register({
      name: 'tools',
      description: '切換工具輸出折疊成一行（Edit、Write、Bash、Read、Grep、Glob）',
    })

    return next(e)
  })

  on('command.run', { command: 'tools' }, async $ => {
    const isOn = await update($, isToolCollapseOn, isOn => !isOn)

    return { text: isOn ? '工具輸出折疊：開' : '工具輸出折疊：關' }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const props = e.props
    // ctrl+o, --verbose and expanded groups show everything; rows still running, failed or interrupted are not hidden either.
    // No output yet means the call has not resolved: the model may still be streaming its input (a Write with neither path nor
    // content, summarized as 「✎ 新增  +0」) or it waits on a permission dialog. The engine's row says which.
    if (
      e.surface !== 'terminal' ||
      props.isExpanded ||
      props.isRunning ||
      props.isErrored ||
      props.isInterrupted ||
      props.output === undefined
    ) {
      return next(e)
    }
    // `Skill(name)  Successfully loaded skill` says only that the model read instructions; focus mode hides both rows.
    if (props.tool === 'Skill' && (await read($, isFocusOn))) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    if (!COLLAPSIBLE.has(props.tool) || !(await read($, isToolCollapseOn))) return next(e)

    const summary = summarizeTool(props.tool, props.input, props.output, places.cwd)
    if (summary === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const open = memberOf(isToolOpen, e)
    const toggle = () => update($, open, isOpen => !isOpen)

    if (await read($, open)) {
      const engine = await next(e)
      return (
        <Box flexDirection="column">
          {engine}
          <Box paddingLeft={BULLET}>
            <Button key="tools:close" label="收合" onPress={toggle} />
          </Box>
        </Box>
      )
    }

    // The whole line is one button; clicking anywhere on the summary expands it.
    const columns = (e.viewport?.columns ?? 80) - BULLET - 1
    const tail = stats(summary)
    const room = columns - displayWidth(OPEN_MARK) - (tail === '' ? 0 : displayWidth(tail) + 2)
    const head = clip(summary.head, Math.max(room, 10))
    const row = (
      <Box flexDirection="row">
        <Box width={BULLET} flexShrink={0}>
          <Text color="success">⏺</Text>
        </Box>
        <Button key="tools:open" label="展開" plain onPress={toggle}>
          {head}
          {summary.added !== undefined && (
            <Text color="diffAdded">  +{summary.added}</Text>
          )}
          {summary.removed !== undefined && (
            <Text color="diffRemoved"> −{summary.removed}</Text>
          )}
          {summary.note !== undefined && (
            <Text dimColor>  （{summary.note}）</Text>
          )}
          <Text dimColor>{OPEN_MARK}</Text>
        </Button>
      </Box>
    )

    const path = text(record(props.input).file_path)
    if (props.tool !== 'Read' || !isImagePath(path)) return row

    // Only the terminal table has Image; elsewhere the summary row stands alone.
    const table = $.ui.resolve(e)
    if (!('Image' in table)) return row
    const { Image } = table
    const image = await loadImage($, { kind: 'local', src: absolutePath(path, places.cwd), alt: baseName(path) }, {
      columns,
      maxRows: THUMB_ROWS,
      allowRemote: false,
    })
    return (
      <Box flexDirection="column">
        {row}
        <Box paddingLeft={BULLET}>
          {image.ok ? (
            <Image source={image.source} columns={image.columns} rows={image.rows} alt={image.alt} />
          ) : (
            <Text dimColor>（縮圖：{image.reason}）</Text>
          )}
        </Box>
      </Box>
    )
  })

  // For a tool on its own row, the result (diff, command output) is drawn here; when collapsed the block is not drawn at all, and when expanded or failed it goes back to the engine.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const props = e.props
    if (e.surface !== 'terminal' || props.isExpanded || props.isErrored) return next(e)
    if (props.tool === 'Skill' && (await read($, isFocusOn))) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    if (!COLLAPSIBLE.has(props.tool) || !(await read($, isToolCollapseOn))) return next(e)
    if (await read($, memberOf(isToolOpen, e))) return next(e)

    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
