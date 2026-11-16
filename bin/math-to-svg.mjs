#!/usr/bin/env node
// Typeset one display-mode TeX formula from stdin into a standalone SVG on stdout, for hooks/math.ts.
// Usage: node math-to-svg.mjs <mathjax-dir> < formula.tex
//
// <mathjax-dir> is where bin/install-mathjax.sh ran `npm install`; the modules are imported by file path
// because this script lives in the mod folder, where a bare `@mathjax/src` specifier would not resolve.
//
// The SVG keeps MathJax's currentColor fill; math.ts swaps in the theme's foreground. width and height are
// rewritten from ex to px (1ex = 8px, MathJax's default 16px em), so math.ts and rsvg-convert agree on the
// natural size without guessing rsvg's ex.
//
// Exit 0 with the SVG on success. Exit 1 with a message on stderr for a TeX error (MathJax would otherwise
// draw the error in red inside the image) or an undefined macro, an over-long input, or a missing install.

import { readFileSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A reply's formula is a few hundred characters; past this it is more likely runaway output than math.
const MAX_INPUT = 4000
const EX_PX = 8

const dir = process.argv[2]
if (!dir) fail('usage: math-to-svg.mjs <mathjax-dir>')
const tex = readFileSync(0, 'utf8').trim()
if (tex === '') fail('empty input')
if (tex.length > MAX_INPUT) fail(`input longer than ${MAX_INPUT} characters`)

// MathJax's SVG font tables dominate start-up; Node's on-disk compile cache takes them from parsing on every
// run to loading cached code. The cache sits beside the install, so removing that directory removes both.
enableCompileCache?.(join(dir, '.compile-cache'))

const src = join(dir, 'node_modules', '@mathjax', 'src', 'mjs')
const load = path => import(pathToFileURL(join(src, path)).href)

const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] = await Promise.all([
  load('mathjax.js'),
  load('input/tex.js'),
  load('output/svg.js'),
  load('adaptors/liteAdaptor.js'),
  load('handlers/html.js'),
  // Sets mathjax.asyncLoad, which MathJax uses for font ranges it loads on demand (\mathbb, \mathfrak, big
  // operators). The import runs from inside node_modules, so the font package's bare specifier resolves there.
  load('util/asyncLoad/esm.js'),
]).catch(error => fail(`MathJax not loadable from ${dir}: ${error.message}`))
// Each package registers itself on import. None has a file-reading command: \input, \include and
// \includegraphics are undefined control sequences, which fail the render, so a formula cannot pull in local files.
await Promise.all(
  ['base/BaseConfiguration.js', 'ams/AmsConfiguration.js', 'newcommand/NewcommandConfiguration.js',
    'boldsymbol/BoldsymbolConfiguration.js'].map(p => load(`input/tex/${p}`)),
)

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const document = mathjax.document('', {
  // formatError turns a TeX error into a thrown one; the default would typeset the message in red.
  InputJax: new TeX({
    // No noundefined: an unknown macro must fail the render, so a ```latex fence holding a whole document
    // (\documentclass, \section) falls back to leaf's frame instead of becoming an image of macro names.
    packages: ['base', 'ams', 'newcommand', 'boldsymbol'],
    formatError: (_jax, error) => {
      throw error
    },
  }),
  // fontCache 'local' keeps the glyph paths inside this one SVG; 'global' would reference a shared <defs> elsewhere.
  OutputJax: new SVG({ fontCache: 'local' }),
})

let node
try {
  // convertPromise waits for any font ranges MathJax loads on demand (larger operators, extra alphabets).
  node = await document.convertPromise(tex, { display: true, em: EX_PX * 2, ex: EX_PX, containerWidth: 80 * 16 })
} catch (error) {
  fail(`TeX error: ${error.message}`)
}

const svg = adaptor.firstChild(node)
for (const side of ['width', 'height']) {
  const value = /^([\d.]+)ex$/.exec(adaptor.getAttribute(svg, side) ?? '')
  if (!value) fail(`unexpected ${side}`)
  adaptor.setAttribute(svg, side, `${(Number(value[1]) * EX_PX).toFixed(2)}px`)
}
// vertical-align only makes sense inline in HTML; rsvg ignores it, and dropping it keeps the output plain.
adaptor.removeAttribute(svg, 'style')
adaptor.setAttribute(svg, 'xmlns', 'http://www.w3.org/2000/svg')
process.stdout.write(adaptor.serializeXML(svg))

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
