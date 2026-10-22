import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'

import {
  base64ByteLength,
  clearMermaidCache,
  decodeBase64Prefix,
  fitCells,
  mermaidAlt,
  parseSize,
  pngSize,
  renderMermaid,
  withTransparentBackground,
} from '../hooks/mermaid'
import type { MermaidEngine } from '../hooks/mermaid'

// The test $ has no process or fs, so fake them: record each argv, answer via respond, fs.read always returns png.
function fakeEngine(respond: (argv: readonly string[]) => ProcessRunResult, png: string) {
  const runs: (readonly string[])[] = []
  const reads: string[] = []
  const $: MermaidEngine = {
    process: {
      run: async argv => {
        runs.push(argv)
        return respond(argv)
      },
    },
    fs: {
      read: async path => {
        reads.push(path)
        return { base64: png }
      },
    },
  }
  return { $, runs, reads }
}

// PNG header for 640×352 (the content is one pixel; the tests only read IHDR).
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAoAAAAFgCAYAAAArYcg8AAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

const FLOWCHART = 'flowchart TD\n  A[開始] --> B{判斷}\n  B -->|是| C[做事]\n'

function ok(stdout = ''): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function fail(): ProcessRunResult {
  return { exitCode: 1, stdout: '', stderr: 'error: invalid flowchart edge syntax', isStdoutTruncated: false, isStderrTruncated: false }
}

// mktemp returns path, mmdr --size returns size, everything else succeeds.
function mmdr(path: string, size: string) {
  return (argv: readonly string[]) => {
    if (argv[0] === 'mktemp') return ok(`${path}\n`)
    if (argv[0] === 'mmdr' && argv.includes('--size')) return ok(size)
    return ok()
  }
}

test('reads width and height from PNG IHDR', () => {
  expect(pngSize(decodeBase64Prefix(PNG_BASE64, 24))).toEqual({ width: 640, height: 352 })
})

test('returns null for non-PNG or truncated data', () => {
  expect(pngSize(new Uint8Array([1, 2, 3]))).toBe(null)
  expect(pngSize(decodeBase64Prefix('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 24))).toBe(null)
})

test('base64 decoded length excludes padding', () => {
  expect(base64ByteLength('YQ==')).toBe(1)
  expect(base64ByteLength('YWI=')).toBe(2)
  expect(base64ByteLength('YWJj')).toBe(3)
  expect([...decodeBase64Prefix('YWJj', 2)]).toEqual([97, 98])
})

test('small image keeps natural size and aspect ratio', () => {
  // 246×308 px, 10×22 per cell: 25 cells wide, 25 × 308/246 × 10/22 ≈ 14 rows high.
  expect(fitCells(246.3, 308.255, 80)).toEqual({ columns: 25, rows: 14 })
})

test('wide image shrinks to available width', () => {
  expect(fitCells(1068.4, 428.7, 80)).toEqual({ columns: 80, rows: 15 })
})

test('tall image is limited by maxRows and narrowed to match', () => {
  expect(fitCells(200, 2000, 80, 40)).toEqual({ columns: 9, rows: 40 })
})

test('cell counts stay within the Image limit of 255', () => {
  const box = fitCells(10000, 100, 400)
  expect(box?.columns).toBe(255)
  expect(box?.rows).toBe(1)
})

test('invalid dimensions return null', () => {
  expect(fitCells(0, 100, 80)).toBe(null)
  expect(fitCells(100, 100, 0)).toBe(null)
})

test('sets a transparent background, leaves an existing init directive alone', () => {
  expect(withTransparentBackground('graph TD')).toBe('%%{init: {"themeVariables": {"background": "transparent"}}}%%\ngraph TD')
  const own = '%%{init: {"theme": "forest"}}%%\ngraph TD'
  expect(withTransparentBackground(own)).toBe(own)
})

test('parses mmdr --size', () => {
  expect(parseSize('{"width": 246.3, "height": 308.255, "viewbox_x": 0.0}')).toEqual({ width: 246.3, height: 308.255 })
  expect(parseSize('error')).toBe(null)
  expect(parseSize('{"width": 0, "height": 10}')).toBe(null)
})

test('alt names the diagram type', () => {
  expect(mermaidAlt('%%{init: {}}%%\n\nsequenceDiagram\n  A->>B: hi')).toBe('mermaid 圖：sequenceDiagram')
  expect(mermaidAlt('graph TD; A-->B')).toBe('mermaid 圖：graph')
  expect(mermaidAlt('')).toBe('mermaid 圖')
})

test('renderMermaid: measures size, renders to box ratio, reads back PNG, deletes temp file', async () => {
  clearMermaidCache()
  const path = '/tmp/readable-chat-mermaid-abc123.png'
  const { $, runs, reads } = fakeEngine(mmdr(path, '{"width": 246.3, "height": 308.255}'), PNG_BASE64)

  const image = await renderMermaid($, FLOWCHART, { columns: 80, isDark: true })
  expect(image).toEqual({
    source: { png: PNG_BASE64 },
    columns: 25,
    rows: 14,
    alt: 'mermaid 圖：flowchart',
    width: 640,
    height: 352,
  })
  expect(runs[0]).toEqual(['mmdr', '-i', '-', '--size', '-t', 'dark'])
  const draw = runs.find(argv => argv[0] === 'mmdr' && argv.includes('-o'))
  expect(draw).toEqual(['mmdr', '-i', '-', '-o', path, '-e', 'png', '-t', 'dark', '-w', '500', '-H', '616'])
  expect(reads).toEqual([path])
  expect(runs.at(-1)).toEqual(['rm', '-f', path])

  // Same code and options hit the cache without spawning a process.
  const count = runs.length
  expect(await renderMermaid($, FLOWCHART, { columns: 80, isDark: true })).toBe(image)
  expect(runs.length).toBe(count)
})

test('renderMermaid: light theme uses mmdr default', async () => {
  clearMermaidCache()
  const { $, runs } = fakeEngine(mmdr('/tmp/readable-chat-mermaid-light.png', '{"width": 100, "height": 50}'), PNG_BASE64)
  expect(await renderMermaid($, FLOWCHART, { columns: 80, isDark: false })).not.toBe(null)
  const themes = runs.filter(argv => argv[0] === 'mmdr').map(argv => argv[argv.indexOf('-t') + 1])
  expect(themes).toEqual(['default', 'default'])
})

test('renderMermaid: mmdr parse failure returns null without creating a temp file', async () => {
  clearMermaidCache()
  const { $, runs } = fakeEngine(() => fail(), PNG_BASE64)
  expect(await renderMermaid($, 'graph TD; A-->', { columns: 80, isDark: true })).toBe(null)
  expect(runs.map(argv => argv[0])).toEqual(['mmdr'])
})

test('renderMermaid: returns null when mmdr is not on PATH', async () => {
  clearMermaidCache()
  const $: MermaidEngine = {
    process: { run: async () => Promise.reject(new Error('spawn mmdr ENOENT')) },
    fs: { read: async () => ({ base64: PNG_BASE64 }) },
  }
  expect(await renderMermaid($, FLOWCHART, { columns: 80, isDark: true })).toBe(null)
})

test('renderMermaid: non-PNG output returns null and still deletes the temp file', async () => {
  clearMermaidCache()
  const path = '/tmp/readable-chat-mermaid-bad.png'
  const { $, runs } = fakeEngine(mmdr(path, '{"width": 100, "height": 50}'), 'PHN2Zz48L3N2Zz4=')
  expect(await renderMermaid($, FLOWCHART, { columns: 60, isDark: true })).toBe(null)
  expect(runs.at(-1)).toEqual(['rm', '-f', path])
})
