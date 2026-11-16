import type { EngineInterface } from 'claude-code'

import type { ImageRef } from '../types'
import { findMathjax, prepareSvg, svgSize } from './math'
import { configPath, parseSize } from './mermaid'

// 「放大」 hands the picture to the desktop's own viewer (xdg-open), which zooms, pans and copies better than any cell grid.
// Local files and URLs open as they are; mermaid and math have no file, so they are rendered once more, large and on an
// opaque background a standalone window needs, into ~/.cache/readable-chat/zoom.

// Pixels per CSS pixel of the natural size: sharp when the viewer fits a diagram to a laptop screen.
const ZOOM_SCALE = 3

// The terminal's background tone, so a diagram opened from a dark chat is not a white flash.
const BACKGROUND = { dark: '#1a1b26', light: '#ffffff' }

function hash(text: string): string {
  let value = 5381
  for (let i = 0; i < text.length; i++) value = ((value << 5) + value + text.charCodeAt(i)) | 0
  return (value >>> 0).toString(36)
}

async function zoomDir($: EngineInterface): Promise<string | null> {
  const run = await $.process.run(
    ['sh', '-c', 'dir="${XDG_CACHE_HOME:-$HOME/.cache}/readable-chat/zoom" && mkdir -p -- "$dir" && printf %s "$dir"'],
    { timeoutMs: 2000 },
  )
  const dir = run.stdout.trim()
  return run.exitCode === 0 && dir.startsWith('/') ? dir : null
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  const run = await $.process.run(['test', '-s', path], { timeoutMs: 1000 })
  return run.exitCode === 0
}

async function mermaidFile($: EngineInterface, code: string, isDark: boolean, path: string): Promise<boolean> {
  const theme = isDark ? 'dark' : 'default'
  const config = await configPath($, isDark)
  const colors = config ? ['-c', config] : []
  const sized = await $.process.run(['mmdr', '-i', '-', '--size', '-t', theme, ...colors], { stdin: code, timeoutMs: 5000 })
  const natural = sized.exitCode === 0 ? parseSize(sized.stdout) : null
  if (!natural) return false
  const width = String(Math.ceil(natural.width * ZOOM_SCALE))
  const height = String(Math.ceil(natural.height * ZOOM_SCALE))
  const drawn = await $.process.run(
    ['mmdr', '-i', '-', '-o', path, '-e', 'png', '-t', theme, ...colors, '-w', width, '-H', height],
    { stdin: code, timeoutMs: 10000 },
  )
  return drawn.exitCode === 0
}

async function mathFile($: EngineInterface, tex: string, isDark: boolean, path: string): Promise<boolean> {
  const dir = await findMathjax($)
  if (!dir) return false
  const typeset = await $.process.run(['node', `${$.plugin.root}/bin/math-to-svg.mjs`, dir], { stdin: tex.trim(), timeoutMs: 3000 })
  const natural = typeset.exitCode === 0 ? svgSize(typeset.stdout) : null
  if (!natural) return false
  const svg = prepareSvg(typeset.stdout, natural.width * ZOOM_SCALE * 2, natural.height * ZOOM_SCALE * 2, isDark)
  const background = isDark ? BACKGROUND.dark : BACKGROUND.light
  const drawn = await $.process.run(['rsvg-convert', '-f', 'png', '-b', background, '-o', path], { stdin: svg, timeoutMs: 3000 })
  return drawn.exitCode === 0
}

// What xdg-open should be given for this picture, or the reason there is nothing to give it.
async function target($: EngineInterface, ref: ImageRef, isDark: boolean): Promise<{ path: string } | { reason: string }> {
  if (ref.kind === 'local' || ref.kind === 'remote') return { path: ref.src }
  const dir = await zoomDir($)
  if (!dir) return { reason: '無法建立快取資料夾' }
  const path = `${dir}/${ref.kind}-${isDark ? 'dark' : 'light'}-${hash(ref.src)}.png`
  if (await exists($, path)) return { path }
  const isDrawn = ref.kind === 'mermaid' ? await mermaidFile($, ref.src, isDark, path) : await mathFile($, ref.src, isDark, path)
  return isDrawn ? { path } : { reason: '轉圖失敗' }
}

// Resolves to null once the viewer is launched, or a short reason for the toast. setsid -f detaches the viewer, so closing
// Claude Code or herdr's pane does not close it, and the hook does not wait on the window.
export async function openInViewer($: EngineInterface, ref: ImageRef, isDark: boolean): Promise<string | null> {
  try {
    const found = await target($, ref, isDark)
    if ('reason' in found) return found.reason
    const run = await $.process.run(['sh', '-c', 'setsid -f xdg-open "$1" >/dev/null 2>&1', 'sh', found.path], { timeoutMs: 5000 })
    return run.exitCode === 0 ? null : '無法開啟系統看圖程式'
  } catch {
    return '無法開啟系統看圖程式'
  }
}
