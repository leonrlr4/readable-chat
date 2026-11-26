import { expect, test } from 'claude-code/testing'
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import {
  MATH_FRAME,
  MATH_FRAME_BOTTOM,
  clearMathCache,
  isComplexMath,
  mathAlt,
  mathBlocks,
  prepareSvg,
  renderMath,
  svgSize,
} from '../hooks/math'
import type { MathEngine } from '../hooks/math'

// Same shape as the mermaid fake, plus the plugin root math-to-svg.mjs is found under.
function fakeEngine(respond: (argv: readonly string[], init?: ProcessRunInit) => ProcessRunResult | Promise<ProcessRunResult>) {
  const runs: { argv: readonly string[]; init?: ProcessRunInit }[] = []
  const reads: string[] = []
  const $: MathEngine = {
    plugin: { root: '/mods/readable-chat' },
    process: {
      run: async (argv, init) => {
        runs.push({ argv, init })
        return respond(argv, init)
      },
    },
    fs: {
      read: async path => {
        reads.push(path)
        return { base64: PNG_BASE64 }
      },
    },
  }
  return { $, runs, reads }
}

// PNG header for 640×352 (the content is one pixel; the code only reads IHDR).
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAoAAAAFgCAYAAAArYcg8AAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

// What math-to-svg.mjs prints for \frac{a+b}{c}, glyphs cut.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="47.43px" height="37.41px" role="img" focusable="false" viewBox="0 -1370 2620.4 2067"><g stroke="currentColor" fill="currentColor"><path d="M0 0"/></g></svg>'

const MATHJAX = '/home/u/.cache/readable-chat/mathjax'

function ok(stdout = ''): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function fail(stderr = 'TeX error: Undefined control sequence \\input'): ProcessRunResult {
  return { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

// sh prints the MathJax directory, node prints the SVG, mktemp a path, everything else succeeds.
function pipeline(overrides: Partial<Record<string, ProcessRunResult>> = {}) {
  return (argv: readonly string[]) => {
    const name = argv[0] ?? ''
    if (overrides[name]) return overrides[name]
    if (name === 'sh') return ok(MATHJAX)
    if (name === 'node') return ok(SVG)
    if (name === 'mktemp') return ok('/tmp/readable-chat-math-abc123.png\n')
    return ok()
  }
}

const OPTIONS = { columns: 80, isDark: true, maxRows: 25 }

test('mathBlocks: $$ blocks and math fences in document order', () => {
  const md = [
    'Intro with inline $\\frac{a}{b}$ math, which leaf does not frame.',
    '',
    '$$E=mc^2$$',
    '',
    '```latex',
    '\\sqrt{x}',
    '```',
    '',
    '```python',
    'print("$$not math$$")',
    '```',
    '',
    '```math',
    '\\sum_i x_i',
    '```',
    '',
    '~~~tex',
    '\\int_0^1 f',
    '~~~',
    '',
    '$$',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '$$',
  ].join('\n')
  expect(mathBlocks(md)).toEqual([
    'E=mc^2',
    '\\sqrt{x}',
    '\\sum_i x_i',
    '\\int_0^1 f',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
  ])
})

test('mathBlocks: fence language is the first info word, any case', () => {
  expect(mathBlocks('```LaTeX\nA\n```\n\n```latex title\nB\n```\n\n```katex\nC\n```\n\n```mathematica\nD\n```')).toEqual(['A', 'B'])
})

test('mathBlocks: $$ inside a sentence, across lines, several per line', () => {
  expect(mathBlocks('text $$a$$ more\n\n$$b$$ and $$c$$\n\npara\n$$\nmulti\nline\n$$\nafter')).toEqual(['a', 'b', 'c', 'multi\nline'])
})

test('mathBlocks: list items and headings are framed, quotes, tables, HTML and code are not', () => {
  const md = [
    '- item $$l$$',
    '- item',
    '  $$m$$',
    '',
    '# Title $$h$$',
    '',
    '> quoted $$q$$',
    '',
    '| a | b |',
    '|---|---|',
    '| $$t$$ | 1 |',
    '',
    '<div>',
    '$$html$$',
    '</div>',
    '',
    'Use `$$code$$` here.',
    '',
    'para',
    '',
    '    $$indented code$$',
  ].join('\n')
  expect(mathBlocks(md)).toEqual(['l', 'm', 'h'])
})

test('mathBlocks: four spaces inside a list is a continuation, not code', () => {
  expect(mathBlocks('- item\n\n    $$x$$')).toEqual(['x'])
})

test('mathBlocks: unclosed, escaped and cancelled $$ stay text', () => {
  expect(mathBlocks('$$\nunclosed\n\nnext')).toEqual([])
  expect(mathBlocks('\\$$a$$')).toEqual([])
  expect(mathBlocks('$$a $ b$$')).toEqual([])
  expect(mathBlocks('$$a \\$ b$$')).toEqual(['a \\$ b'])
  expect(mathBlocks('cost $5 and $$x$$')).toEqual(['x'])
})

test('mathBlocks: front matter is hidden, an unclosed math fence runs to the end', () => {
  expect(mathBlocks('---\ntitle: $$x$$\n---\n$$y$$')).toEqual(['y'])
  expect(mathBlocks('```latex\n\\frac12')).toEqual(['\\frac12'])
  expect(mathBlocks('````\n```latex\nnested\n```\n````')).toEqual([])
})

test('MATH_FRAME matches the labels leaf draws, with a list marker in front', () => {
  for (const top of ['┌─ latex ────┐', '┌─ math ───┐', '┌─ LaTeX ──┐', '┌─ latex title ──┐', '• ┌─ latex ──┐', '12. ┌─ latex ──┐', '◦ ┌─ math ─┐']) {
    expect(MATH_FRAME.test(top)).toBe(true)
  }
  for (const top of ['┌─ mermaid ──┐', '┌─ katex ──┐', '┌─ python ──┐', '▏ ┌─ latex ──┐', '┌─ mathematica ─┐']) {
    expect(MATH_FRAME.test(top)).toBe(false)
  }
  expect(MATH_FRAME_BOTTOM.test('└─┴──────────┘')).toBe(true)
  expect(MATH_FRAME_BOTTOM.test('• └─┴────┘')).toBe(true)
  expect(MATH_FRAME_BOTTOM.test('└──────────┘')).toBe(false)
})

test('isComplexMath: only constructs leaf flattens badly', () => {
  for (const tex of ['\\frac{a}{b}', '\\dfrac12', '\\begin{aligned} a \\end{aligned}', 'a \\\\ b', '\\sqrt{2}', '\\sum_i', '\\int f', '\\prod_k',
    '\\lim_{x \\to 0}', 'a \\over b', '\\binom{n}{k}', '\\pmatrix{a & b}']) {
    expect(isComplexMath(tex)).toBe(true)
  }
  for (const tex of ['E=mc^2', '\\alpha^2 + \\beta', '\\overline{x}', 'x_{i}^{2}', '\\sin\\theta', '\\intercal', '\\limits']) {
    expect(isComplexMath(tex)).toBe(false)
  }
  expect(isComplexMath('\\documentclass{article}\n\\begin{document}\n$\\frac12$\n\\end{document}')).toBe(false)
})

test('svgSize reads the px size math-to-svg.mjs writes', () => {
  expect(svgSize(SVG)).toEqual({ width: 47.43, height: 37.41 })
  expect(svgSize('<svg width="5ex" height="2ex"></svg>')).toBe(null)
  expect(svgSize('error')).toBe(null)
})

test('prepareSvg recolors for the theme and sizes to the box without stretching', () => {
  const dark = prepareSvg(SVG, 100, 88, true)
  expect(dark).toContain('width="100"')
  expect(dark).toContain('height="88"')
  expect(dark).toContain('preserveAspectRatio="xMidYMid meet"')
  expect(dark).not.toContain('currentColor')
  expect(dark).toContain('fill="#e5e5e5"')
  expect(prepareSvg(SVG, 100, 88, false)).toContain('fill="#1f1f1f"')
  // The path's own attributes are left alone.
  expect(dark).toContain('<path d="M0 0"/>')
})

test('mathAlt flattens the TeX to one line', () => {
  expect(mathAlt('\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}')).toBe('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')
  expect(mathAlt('x'.repeat(300)).length).toBe(200)
})

test('renderMath: typesets with node, rasterizes with rsvg-convert, reads the PNG', async () => {
  clearMathCache()
  const { $, runs, reads } = fakeEngine(pipeline())
  const image = await renderMath($, '\\frac{a+b}{c}', OPTIONS)
  // 47.43×37.41 px: 5 cells wide, 5 × 37.41/47.43 × 10/22 ≈ 2 rows.
  expect(image).toEqual({ source: { png: PNG_BASE64 }, columns: 5, rows: 2, alt: '\\frac{a+b}{c}' })

  const node = runs.find(run => run.argv[0] === 'node')
  expect(node?.argv).toEqual(['node', '/mods/readable-chat/bin/math-to-svg.mjs', MATHJAX])
  expect(node?.init?.stdin).toBe('\\frac{a+b}{c}')
  expect(node?.init?.timeoutMs).toBe(3000)

  const rsvg = runs.find(run => run.argv[0] === 'rsvg-convert')
  expect(rsvg?.argv).toEqual(['rsvg-convert', '-f', 'png', '-o', '/tmp/readable-chat-math-abc123.png'])
  // The box at twice its CSS px: 5 × 10 × 2 by 2 × 22 × 2.
  expect(rsvg?.init?.stdin).toContain('width="100"')
  expect(rsvg?.init?.stdin).toContain('height="88"')
  expect(rsvg?.init?.stdin).toContain('#e5e5e5')

  expect(reads).toEqual(['/tmp/readable-chat-math-abc123.png'])
  expect(runs.at(-1)?.argv).toEqual(['rm', '-f', '/tmp/readable-chat-math-abc123.png'])
  // BSD mktemp (macOS) replaces only trailing X's.
  expect(runs.find(run => run.argv[0] === 'mktemp')?.argv.at(-1)).toMatch(/X{6}$/)
  // Every subprocess carries a timeout.
  expect(runs.every(run => typeof run.init?.timeoutMs === 'number')).toBe(true)
})

test('renderMath: maxRows and a narrow column shrink the box', async () => {
  clearMathCache()
  const { $ } = fakeEngine(pipeline())
  const image = await renderMath($, '\\frac{a+b}{c}', { columns: 3, isDark: false, maxRows: 1 })
  expect(image?.rows).toBe(1)
  expect(image?.columns).toBeLessThanOrEqual(3)
})

test('renderMath: cached by tex, columns, theme and maxRows', async () => {
  clearMathCache()
  const { $, runs } = fakeEngine(pipeline())
  await renderMath($, '\\frac12', OPTIONS)
  const first = runs.filter(run => run.argv[0] === 'node').length
  await renderMath($, '\\frac12', OPTIONS)
  expect(runs.filter(run => run.argv[0] === 'node').length).toBe(first)
  await renderMath($, '\\frac12', { ...OPTIONS, isDark: false })
  await renderMath($, '\\frac12', { ...OPTIONS, maxRows: 5 })
  await renderMath($, '\\frac12', { ...OPTIONS, columns: 40 })
  expect(runs.filter(run => run.argv[0] === 'node').length).toBe(first + 3)
  // The MathJax directory is looked up once.
  expect(runs.filter(run => run.argv[0] === 'sh').length).toBe(1)
})

test('renderMath: null when MathJax is missing, TeX fails, rasterizing fails or a step times out', async () => {
  const cases: (() => ReturnType<typeof fakeEngine>)[] = [
    () => fakeEngine(pipeline({ node: fail('MathJax not loadable from /x: Cannot find module') })),
    () => fakeEngine(pipeline({ node: fail() })),
    () => fakeEngine(pipeline({ node: ok('not an svg') })),
    () => fakeEngine(pipeline({ 'rsvg-convert': fail('Error reading SVG') })),
    () => fakeEngine(pipeline({ mktemp: fail('mktemp: failed') })),
    () => fakeEngine(pipeline({ sh: ok('') })),
    () =>
      fakeEngine(argv => {
        if (argv[0] === 'node') throw new Error('timed out after 3000 ms')
        return pipeline()(argv)
      }),
  ]
  for (const make of cases) {
    clearMathCache()
    const { $, runs } = make()
    expect(await renderMath($, '\\frac{a}{b}', OPTIONS)).toBe(null)
    // Once mktemp made a file, it is removed whatever failed after.
    if (runs.some(run => run.argv[0] === 'rsvg-convert')) expect(runs.at(-1)?.argv[0]).toBe('rm')
  }
})

test('renderMath: empty or oversized TeX never runs node', async () => {
  clearMathCache()
  const { $, runs } = fakeEngine(pipeline())
  expect(await renderMath($, '   ', OPTIONS)).toBe(null)
  expect(await renderMath($, 'x'.repeat(5000), OPTIONS)).toBe(null)
  expect(runs.some(run => run.argv[0] === 'node')).toBe(false)
})
