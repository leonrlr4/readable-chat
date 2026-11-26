import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { highlight, hintLabels, linkStarts } from '../hooks/pane'

const PANE = {
  plugin: 'readable-chat',
  component: 'Pane',
  requestId: 'reader',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { title: '閱讀', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Engine = Parameters<TestBody>[0]
type Hook = Parameters<TestBody>[1]

// Stands in for the engine: leaf prints its input unchanged (so lines are the source lines), every other command
// fails silently and is recorded; turn.complete is answered so the pane can be seeded. The kit gives a plugin's
// $.ui.scroll nothing to answer it, so these tests see a jump through the back stack, not the window moving.
function engine(on: Hook, runs: (readonly string[])[] = []) {
  on('process.run', (_, e) => {
    runs.push(e.argv)
    const isLeaf = e.argv[0] === 'leaf'
    const stdout = isLeaf ? String(e.init?.stdin ?? '') : ''
    return { value: { exitCode: isLeaf ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.complete', () => ({ text: '' }))
  return runs
}

async function reply($: Engine, answer: string) {
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: answer.slice(0, 8), reason: 'answer' })
}

test('labels are prefix-free, single letters first, two letters past the alphabet', () => {
  expect(hintLabels(3)).toEqual(['a', 's', 'd'])
  const many = hintLabels(30)
  expect(new Set(many).size).toBe(30)
  for (const label of many) {
    expect(many.some(other => other !== label && other.startsWith(label))).toBe(false)
  }
  expect(many.some(label => label.includes('f') || label.includes('b'))).toBe(false)
})

test('a link leaf splits into spans, or wraps onto the next row, counts once', () => {
  const href = 'https://x.com/a'
  const starts = linkStarts([
    [{ text: '#', style: {}, href }, { text: '手冊', style: { underline: true }, href }],
    [{ text: '續', style: { underline: true }, href }, { text: ' 和 ', style: {} }, { text: 'a/b.ts', style: {}, href: 'file:///a/b.ts' }],
  ])
  expect(starts.map(start => [start.row, start.index])).toEqual([
    [0, 0],
    [1, 2],
  ])
})

test('highlight marks every case-insensitive match across spans', () => {
  const line = highlight([{ text: 'Foo ba', style: {} }, { text: 'r foo', style: { bold: true } }], 'foo')
  expect(line?.filter(span => span.style.inverse).map(span => span.text)).toEqual(['Foo', 'foo'])
  expect(line?.map(span => span.text).join('')).toBe('Foo bar foo')
  expect(highlight([{ text: 'nothing', style: {} }], 'foo')).toBeNull()
})

test('the filter shows only matching lines, highlighted, with a count', async ($, on) => {
  engine(on)
  await reply($, '第一行 alpha\n第二行 beta\nALPHA 第三行')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeTruthy()
  await ui.input({ key: 'pane-query', text: 'alpha', kind: 'change' })
  expect((await ui.find({ type: 'Text', text: /筆/ }))?.text).toBe('2 筆 ')
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeFalsy()
  const marked = await ui.findAll({ type: 'Text', text: /^alpha$/i })
  expect(marked.map(found => found.props.inverse)).toEqual([true, true])
  await ui.press({ key: 'pane-query-clear' })
  expect(await ui.find({ type: 'Text', text: /beta/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /筆/ })).toBeFalsy()
  await ui.unmount()
})

test('labels appear on links and paths, a label opens its target and turns labels off', async ($, on) => {
  const runs = engine(on)
  await reply($, '改 hooks/format.ts:42 再看 https://x.com/a')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'hint:a' })).toBeFalsy()
  await ui.press({ key: 'hint-toggle' })
  expect((await ui.find({ type: 'Button', key: 'hint:a' }))?.props.hotkey).toBe('a')
  expect(await ui.find({ type: 'Button', key: 'hint:s' })).toBeTruthy()
  await ui.press({ key: 'hint:a' })
  const opened = runs.find(argv => argv[0] === 'bash' && /open-in-nvim/.test(argv[1] ?? ''))
  expect(opened?.slice(2)).toEqual([expect.stringMatching(/hooks\/format\.ts$/), '42'])
  expect(await ui.find({ type: 'Button', key: 'hint:a' })).toBeFalsy()
  await ui.press({ key: 'hint-toggle' })
  await ui.press({ key: 'hint:s' })
  // xdg-open on Linux, macOS's open where there is no xdg-open.
  const link = runs.find(argv => argv[0] === 'sh' && argv.at(-1) === 'https://x.com/a')
  expect(link?.[2]).toMatch(/xdg-open/)
  expect(link?.[2]).toMatch(/\bopen "\$1"/)
  await ui.unmount()
})

test('two-letter labels take their first letter from a prefix button', async ($, on) => {
  engine(on)
  await reply($, Array.from({ length: 30 }, (_, i) => `看 https://x.com/${i}`).join('\n'))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'hint-toggle' })
  const prefix = await ui.find({ type: 'Button', key: 'hint-prefix:m' })
  expect(prefix?.props.hotkey).toBe('m')
  await ui.press({ key: 'hint-prefix:m' })
  expect((await ui.find({ type: 'Button', key: 'hint:ma' }))?.props.hotkey).toBe('a')
  expect(await ui.find({ type: 'Button', key: 'hint:a' })).toBeFalsy()
  await ui.unmount()
})

test('back after switching replies restores the previous one', async ($, on) => {
  engine(on)
  await reply($, '# 第一則\n內容一')
  await reply($, '# 第二則\n內容二')
  const ui = await $.ui.mount(PANE)
  const current = async () => (await ui.findAll({ type: 'Text', text: /第.則/ })).find(found => found.props.inverse === true)?.text
  expect(await current()).toContain('第二則')
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeFalsy()
  const tabs = (await ui.findAll({ type: 'Button' })).filter(found => found.key?.startsWith('doc:'))
  const first = tabs.find(found => /第一則/.test(found.text))
  await ui.press({ key: first?.key ?? '' })
  expect(await current()).toContain('第一則')
  expect((await ui.find({ type: 'Button', key: 'back' }))?.props.hotkey).toBe('b')
  await ui.press({ key: 'back' })
  expect(await current()).toContain('第二則')
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeFalsy()
  await ui.unmount()
})

test('a table-of-contents jump can be undone', async ($, on) => {
  engine(on)
  await reply($, '## 甲\n一\n\n## 乙\n二')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeFalsy()
  await ui.press({ key: 'toc-link:1' })
  await ui.press({ key: 'toc-link:0' })
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeTruthy()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeFalsy()
  await ui.unmount()
})
