import { expect, test } from 'claude-code/testing'

import { clip, countDiff, countLines, firstLine, shortPath, summarizeTool, summaryText } from '../hooks/tools'

const CWD = '/repo'

const EDIT_OUTPUT = {
  filePath: '/repo/hooks/format.ts',
  oldString: 'a',
  newString: 'b',
  originalFile: 'a\n',
  structuredPatch: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' x', '-a', '+b', '+c', ' y'] },
    { oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, lines: ['-z', '+w', '\\ No newline at end of file'] },
  ],
  userModified: false,
  replaceAll: false,
}

test('diff added/removed counts skip context and no-newline markers', () => {
  expect(countDiff(EDIT_OUTPUT.structuredPatch)).toEqual({ added: 3, removed: 2 })
})

test('Edit summary: relative path and +/−', () => {
  const summary = summarizeTool('Edit', { file_path: '/repo/hooks/format.ts' }, EDIT_OUTPUT, CWD)
  expect(summary && summaryText(summary)).toBe('✎ 改了 hooks/format.ts  +3 −2')
})

test('Edit without a result yet estimates from old/new_string', () => {
  const summary = summarizeTool('Edit', { file_path: '/elsewhere/a.ts', old_string: 'a\nb', new_string: 'c' }, undefined, CWD)
  expect(summary && summaryText(summary)).toBe('✎ 改了 /elsewhere/a.ts  +1 −2')
})

test('Write counts total lines for a new file, a diff for a rewrite', () => {
  const created = summarizeTool('Write', {}, { type: 'create', filePath: '/repo/a.md', content: 'x\ny\nz\n', structuredPatch: [] }, CWD)
  expect(created && summaryText(created)).toBe('✎ 新增 a.md  +3')
  const updated = summarizeTool(
    'Write',
    {},
    { type: 'update', filePath: '/repo/a.md', content: 'x', structuredPatch: [{ lines: ['-y', '+x'] }] },
    CWD,
  )
  expect(updated && summaryText(updated)).toBe('✎ 改寫 a.md  +1 −1')
})

test('Bash summary: first command line and output line count', () => {
  const output = { stdout: Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n', stderr: 'w1\nw2\n', interrupted: false }
  const summary = summarizeTool('Bash', { command: 'npm test' }, output)
  expect(summary && summaryText(summary)).toBe('$ npm test  （輸出 42 行）')
  const empty = summarizeTool('Bash', { command: 'true' }, { stdout: '', stderr: '', interrupted: false })
  expect(empty && summaryText(empty)).toBe('$ true  （沒有輸出）')
  const background = summarizeTool('Bash', { command: 'sleep 9' }, { stdout: '', stderr: '', backgroundTaskId: 'b1' })
  expect(background && summaryText(background)).toBe('$ sleep 9  （在背景執行）')
})

test('multi-line command keeps only the first line', () => {
  expect(firstLine("cat <<'EOF' > a\nhi\nEOF")).toBe("cat <<'EOF' > a …")
  expect(firstLine('  ls -la  ')).toBe('ls -la')
})

test('Read summary: whole file and partial range', () => {
  const whole = summarizeTool(
    'Read',
    {},
    { type: 'text', file: { filePath: '/repo/a.ts', content: '', numLines: 48, startLine: 1, totalLines: 48 } },
    CWD,
  )
  expect(whole && summaryText(whole)).toBe('❐ 讀了 a.ts  （48 行）')
  const part = summarizeTool(
    'Read',
    {},
    { type: 'text', file: { filePath: '/repo/a.ts', content: '', numLines: 20, startLine: 101, totalLines: 500 } },
    CWD,
  )
  expect(part && summaryText(part)).toBe('❐ 讀了 a.ts  （第 101–120 行，共 500 行）')
})

test('Grep and Glob summaries', () => {
  const grep = summarizeTool('Grep', { pattern: 'TODO', path: '/repo/hooks' }, { mode: 'files_with_matches', numFiles: 3 }, CWD)
  expect(grep && summaryText(grep)).toBe('⌕ 搜尋 TODO 於 hooks  （3 個檔案）')
  const glob = summarizeTool('Glob', { pattern: '**/*.ts' }, { filenames: ['a.ts', 'b.ts'] })
  expect(glob && summaryText(glob)).toBe('⌕ 找檔案 **/*.ts  （2 個檔案）')
})

test('other tools are not collapsed', () => {
  expect(summarizeTool('Agent', {}, {})).toBe(null)
})

test('line counts, paths and clipping', () => {
  expect(countLines('')).toBe(0)
  expect(countLines('a\nb\n\n')).toBe(2)
  expect(shortPath('/repo/x', '/repo')).toBe('x')
  expect(shortPath('/repox/y', '/repo')).toBe('/repox/y')
  expect(clip('改了很長的路徑名稱', 9)).toBe('改了很長…')
  expect(clip('short', 9)).toBe('short')
})

const TOOL_ROW = {
  plugin: 'readable-chat',
  component: 'ToolUse',
  requestId: 'tu-1',
  surface: 'terminal',
  viewport: { columns: 80, rows: 40 },
} as const

const EDIT_ROW = {
  tool_use_id: 'tu-1',
  tool: 'Edit',
  input: { file_path: '/repo/hooks/format.ts', old_string: 'a', new_string: 'b' },
  output: EDIT_OUTPUT,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
}

test('Edit row collapses to one line, expand shows the engine row, collapse folds it again', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...TOOL_ROW, props: EDIT_ROW })
  expect((await ui.find({ type: 'Button', key: 'tools:open' }))?.text).toContain('+3')
  await ui.press({ key: 'tools:open' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.press({ key: 'tools:close' })
  expect(await ui.find({ type: 'Button', key: 'tools:open' })).toBeTruthy()
  await ui.unmount()
})

test('failed rows and ctrl+o expanded rows render as the engine draws them', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const failed = await $.ui.mount({ ...TOOL_ROW, props: { ...EDIT_ROW, isErrored: true, output: 'boom' } })
  expect(await failed.find({ type: 'Button', key: 'tools:open' })).toBeFalsy()
  expect((await failed.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await failed.unmount()
  const expanded = await $.ui.mount({ ...TOOL_ROW, requestId: 'tu-2', props: { ...EDIT_ROW, tool_use_id: 'tu-2', isExpanded: true } })
  expect(await expanded.find({ type: 'Button', key: 'tools:open' })).toBeFalsy()
  await expanded.unmount()
})

test('collapsed rows hide the result block; with /tools off the engine draws them', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const result = { ...TOOL_ROW, component: 'ToolResult', props: { tool_use_id: 'tu-1', tool: 'Edit', output: EDIT_OUTPUT, isErrored: false } } as const
  const hidden = await $.ui.mount(result)
  expect(await hidden.find({ type: 'Text', text: /engine/ })).toBeFalsy()
  await hidden.unmount()
  const run = { command: 'tools', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const
  expect(await $.command.run(run)).toEqual({ text: '工具輸出折疊：關' })
  const shown = await $.ui.mount(result)
  expect((await shown.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await shown.unmount()
})
