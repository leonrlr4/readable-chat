import { expect, test } from 'claude-code/testing'

import { parseAnsi } from '../hooks/ansi'
import { linkify, sourceLinks } from '../hooks/links'
import { cleanSelection, sourceSlice } from '../hooks/copy'
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

test('a reply drawn again reuses what it drew; new text draws anew', async ($, on) => {
  let runs = 0
  on('process.run', (_, e) => {
    if (e.argv[0] === 'leaf') runs++
    const stdout = e.argv[0] === 'leaf' ? (runs === 1 ? '第一版\n' : '第二版\n') : ''
    return { value: { exitCode: e.argv[0] === 'leaf' ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const message = { ...MESSAGE, requestId: 'kept-1' }
  for (const text of ['第一版', '第一版', '第二版']) {
    const ui = await $.ui.mount({ ...message, props: { text, isFirstOfReply: true } })
    expect((await ui.find({ type: 'Text', text: new RegExp(text) }))?.text).toContain(text)
    await ui.unmount()
  }
  expect(runs).toBe(2)
})

const PLACES = { cwd: '/repo', home: '/home/me' }

test('spans of one style join; blanks join when it would not show; a link marker stays alone', () => {
  const grey = '\x1b[38;2;208;210;218m'
  const line = `${grey}Done\x1b[0m${grey} \x1b[0m${grey}when\x1b[0m \x1b[1msaved\x1b[0m ${grey}#\x1b[0m\x1b[4mdocs\x1b[0m`
  expect(parseAnsi(line)[0]).toEqual([
    { text: 'Done when ', style: { color: '#d0d2da' } },
    { text: 'saved ', style: { bold: true } },
    { text: '#', style: { color: '#d0d2da' } },
    { text: 'docs', style: { underline: true } },
  ])
})

test('links drawn by leaf map back to the source URL', () => {
  const lines = parseAnsi('看 \x1b[38;2;85;148;235m#\x1b[0m\x1b[38;2;88;152;238;4m部署手冊\x1b[0m 再問\n')
  const [line] = linkify(lines, '看 [部署手冊](https://example.com/runbook) 再問', PLACES)
  expect(line?.filter(span => span.href).map(span => span.text)).toEqual(['部署手冊'])
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

test('a selection over wrapped lines copies its source lines, backticks kept', () => {
  const source = ['回覆說明。', '', '- 欄位 `version_no` 和 `size_bytes` 要一起改，', '  不然 migration 會失敗。', '- 另一點'].join('\n')
  const selected = ['  • 欄位 version_no 和 size_bytes 要一起改，不然', '    migration 會失敗。'].join('\n')
  expect(sourceSlice(selected, source)).toBe('- 欄位 `version_no` 和 `size_bytes` 要一起改，\n  不然 migration 會失敗。')
})

test('a selection inside one line widens over the markup at its ends', () => {
  expect(sourceSlice('version_no', '改 `version_no` 欄位')).toBe('`version_no`')
  expect(sourceSlice('重點', '這是**重點**。')).toBe('**重點**')
})

test('a selection inside a code block keeps its fences', () => {
  const source = '看這段：\n\n```sh\nwl-copy < a.txt\nls\n```\n\n完'
  const selected = ['  ┌─ sh ────────────┐', '  │1│ wl-copy < a.txt │', '  │2│ ls              │', '  └─┴───────────────┘'].join('\n')
  expect(sourceSlice(selected, source)).toBe('```sh\nwl-copy < a.txt\nls\n```')
})

test('a screen copy with padding and a copy button traces back to its source', () => {
  const source = 'Hey, you can start the runs.\n\n1) #12 and `parser.ts`: thanks for fixing it.\n2) Smoke test: passing on main.'
  const herdr = [
    '⏺ Hey, you can start the runs.                                  ⧉ 複製',
    '',
    '  1. #12 and parser.ts: thanks for fixing it.     ',
    '  2. Smoke test: passing on main.     ',
  ].join('\n')
  expect(sourceSlice(herdr, source)).toBe(source)
  expect(sourceSlice('https://example.com/run/1\nsomething else entirely', source)).toBeNull()
})

test('a screen copy with the sticky heading drawn over several rows still finds its source', () => {
  const source = [
    '## 複製時能拿回原文',
    '',
    '選取畫面上的字複製時，剪貼簿裡拿到的是 leaf 畫出來的版本，不是原文：',
    '',
    '- 有序清單的 `1)` 變成 `1.`，貼進 Slack 後會被轉成清單。',
    '- `snake_case` 這類名稱前後的反引號消失，底線被 Slack 當成斜體。',
    '- leaf 為了塞進螢幕寬度自動換的行，複製後變成真的換行。',
    '',
    '現在 mod 監看剪貼簿，只要剪貼簿的內容能對回某則回覆的原文，就換成原文。',
  ].join('\n')
  const screen = [
    '  複製時能拿回原文',
    '  ────────────────',
    '   ▸ 複製時能拿回原文 ，剪貼簿裡拿到的是 leaf 畫出來的版本，不是原文：',
    '  • 有序清單的 1) 變成 1.，貼進 Slack 後會被轉成清單。',
    '   ▸ 複製時能拿回原文 稱前後的反引號消失，底線被 Slack 當成斜體。',
    '  • leaf 為了塞進螢幕寬度自動換的行，複製後變成真的換行。',
    '   ▸ 複製時能拿回原文',
    '  現在 mod 監看剪貼簿，只要剪貼簿的內容能對回某則回覆的原文，就換成原文。',
  ].join('\n')
  expect(sourceSlice(screen, source)).toBe(source)
})

test('a selection from elsewhere has no source', () => {
  expect(sourceSlice('完全不相干的字', '回覆內容')).toBeNull()
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

test('replies from earlier turns draw dim once the next prompt is sent', async ($, on) => {
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'leaf' ? 0 : 1,
      stdout: '舊的回覆\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'msg-dim', props: { text: '舊的回覆', isFirstOfReply: true } })
  // leaf's line is a truncating Text around one Text per span; the span carries the style.
  const isDim = async () => (await ui.findAll({ type: 'Text', text: '舊的回覆' })).some(found => found.props.dimColor === true)
  expect(await isDim()).toBe(false)
  await $.prompt.submit({ text: '下一個問題', wait: false, origin: { kind: 'composer' } })
  expect(await isDim()).toBe(true)
  await ui.unmount()
})

test('typed prompts get a rule above them; the turn-duration line is hidden', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const base = { plugin: 'readable-chat', surface: 'terminal', viewport: { columns: 20, rows: 40 } } as const
  const prompt = await $.ui.mount({
    ...base,
    component: 'UserMessage',
    requestId: 'u-1',
    props: { text: '問題', origin: { kind: 'composer' }, isExpanded: true },
  })
  expect((await prompt.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(19))
  expect(await prompt.find({ type: 'Text', text: 'engine' })).toBeTruthy()
  await prompt.unmount()
  const notice = await $.ui.mount({
    ...base,
    component: 'UserMessage',
    requestId: 'u-2',
    props: { text: '通知', origin: { kind: 'task-notification' }, isExpanded: false },
  })
  expect(await notice.find({ type: 'Text', text: /^─+$/ })).toBeFalsy()
  await notice.unmount()
  const duration = await $.ui.mount({ ...base, component: 'TurnDuration', requestId: 't-1', props: { word: 'Worked', durationMs: 23000 } })
  expect(await duration.find({ type: 'Text', text: 'engine' })).toBeFalsy()
  await duration.unmount()
  const run = { command: 'focus-mode', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const
  expect(await $.command.run(run)).toEqual({ text: '專注模式：關' })
  const shown = await $.ui.mount({ ...base, component: 'TurnDuration', requestId: 't-2', props: { word: 'Worked', durationMs: 23000 } })
  expect(await shown.find({ type: 'Text', text: 'engine' })).toBeTruthy()
  await shown.unmount()
})
