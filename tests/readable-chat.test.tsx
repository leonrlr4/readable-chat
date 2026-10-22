import { expect, test } from 'claude-code/testing'

import { parseAnsi } from '../hooks/ansi'
import { linkify, sourceLinks } from '../hooks/links'
import { cleanSelection } from '../hooks/copy'
import { cardifyTables, cardifyWideTables, codeBlocks, displayWidth, fold, minWidth } from '../hooks/format'

const WIDE = [
  '| 名稱 | 狀態 | 負責人 | 截止日 | 說明 |',
  '| --- | --- | --- | --- | --- |',
  '| 登入流程 | 進行中 | 小王 | 2026-11-01 | 要支援 magic link 和 SSO 兩種登入方式 |',
].join('\n')

const NARROW = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')

const LONG = [
  '結論：先修登入。',
  '',
  '## 背景',
  ...Array.from({ length: 50 }, (_, i) => `第 ${i} 行`),
  '## 做法',
  '最後一行',
].join('\n')

const MESSAGE = {
  plugin: 'readable-chat',
  component: 'AssistantMessage',
  requestId: 'msg-1',
  surface: 'terminal',
  viewport: { columns: 60, rows: 40 },
} as const

test('CJK characters count as two columns', () => {
  expect(displayWidth('ab中文')).toBe(6)
  expect(displayWidth('**粗**')).toBe(2)
})

test('wide tables become cards, narrow tables stay', () => {
  const cards = cardifyWideTables(WIDE, 60)
  expect(cards).toContain('**登入流程**')
  expect(cards).toContain('- 負責人：小王')
  expect(cardifyWideTables(NARROW, 60)).toBe(NARROW)
  expect(cardifyWideTables(WIDE, 200)).toBe(WIDE)
})

test('tables inside a code fence stay', () => {
  const fenced = '```\n' + WIDE + '\n```'
  expect(cardifyWideTables(fenced, 40)).toBe(fenced)
})

test('folding keeps a summary and an outline', () => {
  const folded = fold(LONG)
  expect(folded.summary).toBe('結論：先修登入。')
  expect(folded.outline).toEqual(['背景', '做法'])
})

test('long reply renders folded, expand shows the full text', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const ui = await $.ui.mount({ ...MESSAGE, props: { text: LONG, isFirstOfReply: true } })
  // The latest reply shows in full; it folds only after the next prompt is submitted.
  expect(await ui.find({ type: 'Text', text: /折疊了/ })).toBeFalsy()
  await $.prompt.submit({ text: '下一個問題', wait: false, origin: { kind: 'composer' } })
  expect((await ui.find({ type: 'Text', text: /折疊了/ }))?.text).toContain('折疊了')
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Button', key: 'collapse' })).toBeTruthy()
  await ui.unmount()
})

test('short replies are left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...MESSAGE, props: { text: '短短一句', isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('parses leaf 24-bit color and bold', () => {
  const [line] = parseAnsi('\x1b[38;2;140;190;255;1m標題\x1b[0m 內文\n')
  expect(line?.[0]).toEqual({ text: '標題', style: { color: '#8cbeff', bold: true } })
  expect(line?.[1]).toEqual({ text: ' 內文', style: {} })
})

test('renders the reply from leaf output when leaf is available', async ($, on) => {
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'leaf' ? 0 : 1,
      stdout: '\x1b[38;2;140;190;255;1m部署狀態\x1b[0m\n════════\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  const ui = await $.ui.mount({ ...MESSAGE, props: { text: '# 部署狀態', isFirstOfReply: true } })
  expect((await ui.find({ type: 'Text', text: /════/ }))?.text).toBe('════════')
  await ui.unmount()
})

const PLACES = { cwd: '/repo', home: '/home/me' }

test('links drawn by leaf map back to the source URL', () => {
  const lines = parseAnsi('看 \x1b[38;2;85;148;235m#\x1b[0m\x1b[38;2;88;152;238;4m部署手冊\x1b[0m 再問\n')
  const [line] = linkify(lines, '看 [部署手冊](https://example.com/runbook) 再問', PLACES)
  expect(line?.filter(span => span.href).map(span => span.text)).toEqual(['#', '部署手冊'])
  expect(line?.[2]?.href).toBe('https://example.com/runbook')
})

test('URLs and file paths are clickable, line numbers stay out of href', () => {
  const [line] = linkify(
    [[{ text: '改 hooks/format.ts:42 和 ~/notes/a.md，見 https://x.com/a。', style: {} }]],
    '',
    PLACES,
  )
  const linked = line?.filter(span => span.href).map(span => [span.text, span.href])
  expect(linked).toEqual([
    ['hooks/format.ts', 'file:///repo/hooks/format.ts'],
    ['~/notes/a.md', 'file:///home/me/notes/a.md'],
    ['https://x.com/a', 'https://x.com/a'],
  ])
})

test('links inside a code fence do not count', () => {
  expect(sourceLinks('```\n[a](https://a.com)\n```\n[b](https://b.com)')).toEqual(['https://b.com'])
})

test('in fullscreen, clicking a file path opens it with open-in-nvim at the line', async ($, on) => {
  const runs: (readonly string[])[] = []
  on('process.run', (_, e) => {
    runs.push(e.argv)
    const stdout = e.argv[0] === 'leaf' ? '改 \x1b[38;2;220;150;118;48;2;38;32;31m hooks/format.ts:42 \x1b[0m\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount({
    ...MESSAGE,
    viewport: { columns: 60, rows: 40, isFullscreen: true },
    props: { text: '改 `hooks/format.ts:42`', isFirstOfReply: true },
  })
  await ui.press({ key: 'msg-1:open:0:2' })
  const opened = runs.find(argv => argv[0] === 'bash' && /open-in-nvim/.test(argv[1] ?? ''))
  expect(opened?.[1]).toMatch(/bin\/open-in-nvim\.sh$/)
  expect(opened?.slice(2)).toEqual([expect.stringMatching(/hooks\/format\.ts$/), '42'])
  await ui.unmount()
})

const THREE_LONG = [
  '| 項目 | 狀態 | 說明 |',
  '| --- | --- | --- |',
  '| 登入 | 進行中 | 驗證流程已寫完，還缺過期處理和單元測試，預計下週前補齊 |',
].join('\n')

test('minimum width: longest word for English, one character for CJK', () => {
  expect(minWidth('hello wonderful world')).toBe(9)
  expect(minWidth('驗證流程')).toBe(2)
})

test('3-column table with long text is left to leaf in-cell wrapping, 6 columns that do not fit become cards', () => {
  expect(cardifyTables(THREE_LONG, 40)).toBe(THREE_LONG)
  expect(cardifyTables(WIDE, 40)).toContain('**登入流程**')
  expect(cardifyTables('| a | b |\n| --- | --- |\n| supercalifragilistic | x |', 12)).toContain('**supercalifragilistic**')
})

test('summary uses the 「**重點**：」 paragraph when present', () => {
  const folded = fold('前言一句。\n\n**重點**：先修登入。\n\n## 背景\n內容')
  expect(folded.summary).toBe('**重點**：先修登入。')
})

test('code block sources in order, mermaid excluded', () => {
  const text = '```ts\nconst a = 1\n```\n\n```mermaid\ngraph TD\n```\n\n```\nls\n```'
  expect(codeBlocks(text)).toEqual(['const a = 1', 'ls'])
})

test('strips borders, line numbers and wraps from selected text', () => {
  const selected = [
    '⏺ 部署狀態',
    '  ════════',
    '  三個服務已經上 staging，登入服務卡',
    '  在 token 過期處理。',
    '',
    '  ┌──────┬────────┐',
    '  │ 名稱 │ 說明   │',
    '  ╞══════╪════════╡',
    '  │ 登入 │ 還缺過 │',
    '  │      │ 期處理 │',
    '  └──────┴────────┘',
    '  ┌─ python ─────┐',
    '  │1│ def hi():  │',
    '  │2│     return │',
    '  └─┴────────────┘',
  ].join('\n')
  expect(cleanSelection(selected)).toBe(
    [
      '# 部署狀態',
      '三個服務已經上 staging，登入服務卡在 token 過期處理。',
      '',
      '| 名稱 | 說明 |',
      '| --- | --- |',
      '| 登入 | 還缺過期處理 |',
      '```python',
      'def hi():',
      '    return',
      '```',
    ].join('\n'),
  )
})

test('folded reply has outline buttons and copy source', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const ui = await $.ui.mount({ ...MESSAGE, props: { text: LONG, isFirstOfReply: true } })
  await $.prompt.submit({ text: '下一個問題', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Button', key: 'outline:1' })).toBeTruthy()
  await ui.press({ key: 'copy' })
  expect(copied).toEqual([LONG])
  await ui.unmount()
})

test('/format toggles the injected rules, off injects nothing', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '原本的', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const compose = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }
  expect((await $.prompt.compose(compose)).sections.map(one => one.id)).toEqual(['intro', 'readable-chat:format'])
  await $.command.run({ command: 'format', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
  expect((await $.prompt.compose(compose)).sections.map(one => one.id)).toEqual(['intro'])
})

test('when the reply top scrolls off screen, the last passed heading pins to the first visible row', async ($, on) => {
  const stdout = ['背景', '────', '第一段', '做法', '────', '第二段', '第三段', '第四段'].join('\n') + '\n'
  on('process.run', () => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const ui = await $.ui.mount({
    ...MESSAGE,
    props: { text: '## 背景\n第一段\n\n## 做法\n第二段', isFirstOfReply: true, onScreen: { first: 5, last: 7, of: 8 } },
  })
  expect((await ui.find({ type: 'Text', text: /▸ 做法/ }))?.text).toContain('做法')
  await ui.unmount()
})
