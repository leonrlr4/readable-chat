import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { clearImageCache, extractImages } from '../hooks/images'
import { clearMathCache } from '../hooks/math'
import { clearMermaidCache } from '../hooks/mermaid'
import { PICTURES_LEAF_INPUT, PICTURES_LEAF_OUTPUT } from './snapshots/pictures-leaf'

type Hook = Parameters<TestBody>[1]

// One reply with every kind of picture: a local image, a missing one, a mermaid diagram, a complex and a simple formula,
// and a code block after them all, whose copy button must still be block 0.
const SOURCE = [
  '看圖',
  '',
  '![架構圖](/repo/a.png)',
  '',
  '![不見了](/repo/gone.png)',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  '$$\\frac{a}{b}$$',
  '',
  '$$x^2$$',
  '',
  '```js',
  'let a = 1',
  '```',
].join('\n')

const MESSAGE = {
  plugin: 'readable-chat',
  component: 'AssistantMessage',
  surface: 'terminal',
  viewport: { columns: 60, rows: 40, isFullscreen: true },
} as const

const PANE = {
  plugin: 'readable-chat',
  component: 'Pane',
  requestId: 'reader',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: { title: '閱讀', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// PNG header for 640×352 (only IHDR is read); same fixture as images.test.ts.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAoAAAAFgCAYAAAArYcg8AAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
const CACHE = '/home/me/.cache/readable-chat/images'

function ran(exitCode: number, stdout = '') {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

// Fake host: leaf answers SOURCE's leaf input with its real recorded output (anything else is echoed), images load through
// the same stat/file/magick steps as tools.test.tsx, and mmdr and MathJax succeed or fail as asked.
function fakeHost(on: Hook, { mermaid = false, math = true, leaf = {} as Record<string, string> } = {}) {
  const files: Record<string, string> = { '/repo/a.png': 'regular file\t12345\t1700000000' }
  const runs: (readonly string[])[] = []
  on('process.run', (_, e) => {
    const argv = e.argv
    runs.push(argv)
    const stdin = String(e.init?.stdin ?? '')
    switch (argv[0]) {
      case 'leaf':
        return ran(0, stdin === PICTURES_LEAF_INPUT ? PICTURES_LEAF_OUTPUT : (leaf[stdin] ?? stdin))
      case 'stat': {
        const line = files[argv.at(-1) ?? '']
        return line ? ran(0, `${line}\n`) : ran(1)
      }
      case 'sh':
        return ran(0, argv.some(arg => arg.includes('mathjax')) ? '/home/me/.cache/readable-chat/mathjax' : CACHE)
      case 'sha256sum':
        return ran(0, `${'b'.repeat(64)}  -\n`)
      case 'file':
        return ran(0, 'image/png\n')
      case 'magick':
        if (argv[1] === 'identify') return ran(0, '640 352\n')
        files[(argv.at(-1) ?? '').replace(/^PNG:/, '')] = 'regular file\t5000\t1'
        return ran(0)
      case 'mmdr':
        if (!mermaid) return ran(1)
        return argv.includes('--size') ? ran(0, '{"width": 240, "height": 300}') : ran(0)
      case 'node':
        return math ? ran(0, '<svg width="47.43px" height="37.41px" viewBox="0 0 1 1"></svg>') : ran(1)
      case 'mktemp':
        return ran(0, '/tmp/readable-chat-test.png\n')
      case 'bash':
        return ran(1)
      default:
        return ran(0)
    }
  })
  on('fs.read', () => ({ value: { base64: PNG_BASE64 } }))
  on('turn.complete', () => ({ text: '' }))
  return runs
}

function fresh() {
  clearImageCache()
  clearMermaidCache()
  clearMathCache()
}

test('the recorded leaf input is what extractImages makes of the reply', () => {
  expect(extractImages(SOURCE, { cwd: '/repo', home: '/home/me' }).text).toBe(PICTURES_LEAF_INPUT)
})

test('a standalone image becomes an Image with a caption; a missing one shows why', async ($, on) => {
  fresh()
  fakeHost(on)
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-1', props: { text: SOURCE, isFirstOfReply: true } })
  const images = await ui.findAll({ type: 'Image' })
  // a.png and the fraction; mermaid failed and x² is simple, so both stay leaf's frames.
  expect(images.map(image => image.props.alt)).toEqual(['架構圖', '\\frac{a}{b}'])
  expect(images.every(image => Number(image.props.rows) <= 20)).toBe(true)
  expect((await ui.find({ type: 'Text', text: /圖：架構圖/ }))?.text).toBe('圖：架構圖')
  expect((await ui.find({ type: 'Text', text: /不見了/ }))?.text).toBe('圖：不見了（檔案不存在）')
  // Fullscreen: the path is a Button that opens it, like the paths leaf draws.
  expect(await ui.find({ type: 'Button', key: 'pic-1:pic-open:img1' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pic-1:zoom:img1' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'pic-1:zoom:img0' })).toBeTruthy()
  // No readable-image frame text is left behind.
  expect(await ui.find({ type: 'Text', text: /readable-image/ })).toBeFalsy()
  await ui.unmount()
})

test('mermaid that fails to render keeps the ASCII and says so; one that renders gets a caption', async ($, on) => {
  fresh()
  fakeHost(on)
  const failed = await $.ui.mount({ ...MESSAGE, requestId: 'pic-2', props: { text: SOURCE, isFirstOfReply: true } })
  expect(await failed.find({ type: 'Text', text: '（mermaid 轉圖失敗，顯示 ASCII 版）' })).toBeTruthy()
  expect(await failed.find({ type: 'Text', text: /┌─ mermaid/ })).toBeTruthy()
  await failed.unmount()
})

test('a rendered mermaid diagram has 原始碼 and 放大 buttons', async ($, on) => {
  fresh()
  fakeHost(on, { mermaid: true })
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-3', props: { text: SOURCE, isFirstOfReply: true } })
  expect((await ui.findAll({ type: 'Image' })).map(image => image.props.alt)).toContain('mermaid graph')
  expect(await ui.find({ type: 'Text', text: /mermaid 轉圖失敗/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'pic-3:src:mmd0' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pic-3:zoom:mmd0' })).toBeTruthy()
  await ui.unmount()
})

// leaf 1.28.3 draws xychart-beta as a code frame (`└─┴─┘` bottom) and pie as ASCII (`└─┘` bottom); a pie after an
// xychart must keep its own frame instead of being taken for the end of the xychart's.
const CHARTS_SOURCE = [
  '```mermaid',
  'xychart-beta',
  '    x-axis [a, b]',
  '    bar [1, 2]',
  '```',
  '',
  '說明',
  '',
  '```mermaid',
  'pie title P',
  '    "A" : 1',
  '    "B" : 2',
  '```',
].join('\n')

const CHARTS_LEAF_OUTPUT =
  '┌─ mermaid ──────────────────────────────────┐\n│1│ xychart-beta                             │\n│2│     x-axis [a, b]                        │\n│3│     bar [1, 2]                           │\n└─┴──────────────────────────────────────────┘\n\n說明\n┌─ mermaid ───────────────────────────────────┐\n│ P                                           │\n│ ██████████▌                       A  33.3%  │\n│ █████████████████████             B  66.7%  │\n└─────────────────────────────────────────────┘\n'

test('a pie after a code-framed xychart keeps its own picture and the text between them', async ($, on) => {
  fresh()
  fakeHost(on, { mermaid: true, leaf: { [CHARTS_SOURCE]: CHARTS_LEAF_OUTPUT } })
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-charts', props: { text: CHARTS_SOURCE, isFirstOfReply: true } })
  expect((await ui.findAll({ type: 'Image' })).map(image => image.props.alt)).toEqual(['mermaid xychart-beta', 'mermaid pie'])
  expect(await ui.find({ type: 'Text', text: /說明/ })).toBeTruthy()
  await ui.unmount()
})

test('complex math becomes an Image, simple math stays text, and the code block keeps copy button 0', async ($, on) => {
  fresh()
  const runs = fakeHost(on)
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-4', props: { text: SOURCE, isFirstOfReply: true } })
  expect(runs.filter(argv => argv[0] === 'node').length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /x²/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pic-4:src:math0' })).toBeTruthy()
  // Math frames have the `│1│` gutter of a code frame; they must not take the code block's copy index.
  expect(await ui.find({ type: 'Button', key: 'pic-4:code:0' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pic-4:code:1' })).toBeFalsy()
  await ui.unmount()
})

test('complex math that fails to render keeps leaf frame with a note', async ($, on) => {
  fresh()
  fakeHost(on, { math: false })
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-5', props: { text: SOURCE, isFirstOfReply: true } })
  expect(await ui.find({ type: 'Text', text: /a\/b/ })).toBeTruthy()
  expect((await ui.findAll({ type: 'Text', text: '（數學式轉圖失敗，顯示文字版）' })).length).toBe(1)
  await ui.unmount()
})

test('原始碼 swaps the picture for its source and back', async ($, on) => {
  fresh()
  fakeHost(on)
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-6', props: { text: SOURCE, isFirstOfReply: true } })
  expect((await ui.find({ type: 'Button', key: 'pic-6:src:img0' }))?.text).toBe('[原始碼]')
  await ui.press({ key: 'pic-6:src:img0' })
  expect(await ui.find({ type: 'Text', text: '![架構圖](/repo/a.png)' })).toBeTruthy()
  expect((await ui.findAll({ type: 'Image' })).map(image => image.props.alt)).toEqual(['\\frac{a}{b}'])
  expect((await ui.find({ type: 'Button', key: 'pic-6:src:img0' }))?.text).toBe('[顯示圖]')
  expect(await ui.find({ type: 'Button', key: 'pic-6:zoom:img0' })).toBeFalsy()
  await ui.press({ key: 'pic-6:src:math0' })
  expect(await ui.find({ type: 'Text', text: '\\frac{a}{b}' })).toBeTruthy()
  await ui.press({ key: 'pic-6:src:img0' })
  expect((await ui.findAll({ type: 'Image' })).map(image => image.props.alt)).toEqual(['架構圖'])
  await ui.unmount()
})

test('放大 opens the original file in the desktop image viewer', async ($, on) => {
  fresh()
  const runs = fakeHost(on)
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-7', props: { text: SOURCE, isFirstOfReply: true } })
  await ui.press({ key: 'pic-7:zoom:img0' })
  expect(runs.find(argv => argv[0] === 'sh' && argv.some(arg => arg.includes('xdg-open')))?.at(-1)).toBe('/repo/a.png')
  // setsid and xdg-open do not exist on macOS; there the script falls back to open.
  expect(runs.find(argv => argv.at(-1) === '/repo/a.png' && argv[0] === 'sh')?.[2]).toMatch(/else open "\$1"/)
  await ui.unmount()
})

test('放大 on a mermaid diagram opens a large render from the zoom cache', async ($, on) => {
  fresh()
  const runs = fakeHost(on, { mermaid: true })
  const ui = await $.ui.mount({ ...MESSAGE, requestId: 'pic-8', props: { text: SOURCE, isFirstOfReply: true } })
  await ui.press({ key: 'pic-8:zoom:mmd0' })
  const opened = runs.find(argv => argv[0] === 'sh' && argv.some(arg => arg.includes('xdg-open')))?.at(-1) ?? ''
  expect(opened).toMatch(/\/mermaid-dark-\w+\.png$/)
  await ui.unmount()
})

test('/images reports and toggles remote images, off by default', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('process.run', () => ran(1))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const run = (args: string) =>
    $.command.run({ command: 'images', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
  expect((await run(''))?.text).toContain('遠端圖片：關')
  expect((await run('remote on'))?.text).toContain('遠端圖片：開')
  expect((await run(''))?.text).toContain('遠端圖片：開')
  expect((await run('remote off'))?.text).toContain('遠端圖片：關')
})
