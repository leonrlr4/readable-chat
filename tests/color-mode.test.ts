import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'

import { renderWithLeaf, setColorMode, watchTheme } from '../hooks/render'

function result(exitCode: number, stdout = ''): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

test('leaf colors skip the Omarchy theme, system colors bring it back, and each switch redraws', async () => {
  const state = { store: new Map<string, unknown>(), leafArgs: [] as string[][], themeRuns: 0, invalidations: 0 }
  const $ = {
    plugin: { root: '/mod' },
    clock: { now: async () => 0 },
    store: {
      get: async (key: string) => state.store.get(key),
      set: async (key: string, value: unknown) => void state.store.set(key, value),
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'bash') {
          state.themeRuns++
          return result(0, '--theme\n/cache/omarchy.toml\n')
        }
        if (argv[0] === 'stat') return result(0, '1')
        if (argv[0] === 'leaf') {
          state.leafArgs.push([...argv])
          return result(0, 'text\n')
        }
        return result(1)
      },
    },
    ui: { invalidate: () => void state.invalidations++ },
  } as never

  await setColorMode($, 'leaf')
  expect(state.store.get('colorMode')).toBe('leaf')
  await renderWithLeaf($, '配色測試', 40)
  expect(state.leafArgs.at(-1)).not.toContain('--theme')
  expect(state.themeRuns).toBe(0)

  await setColorMode($, 'system')
  await renderWithLeaf($, '配色測試', 40)
  expect(state.leafArgs.at(-1)).toContain('--theme')
  expect(state.invalidations).toBeGreaterThanOrEqual(2)
})

test('a mode saved by another session is picked up by the theme poll and redraws', async () => {
  const state = { store: new Map<string, unknown>([['colorMode', 'system']]), invalidations: 0 }
  let poll = () => {}
  const $ = {
    plugin: { root: '/mod' },
    clock: {
      now: async () => 0,
      every: (_ms: number, fn: () => void) => {
        poll = fn
        return { cancel: () => {} }
      },
    },
    store: { get: async (key: string) => state.store.get(key), set: async () => {} },
    fs: { read: async () => 'background=111111' },
    process: { run: async () => result(0, '--theme\n/cache/omarchy.toml\n') },
    ui: { invalidate: () => void state.invalidations++ },
  } as never
  const tick = async () => {
    poll()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  watchTheme($, '/home/me')
  await tick()
  state.store.set('colorMode', 'leaf')
  await tick()
  expect(state.invalidations).toBe(1)
  await tick()
  expect(state.invalidations).toBe(1)
  state.store.set('colorMode', 'system')
  await tick()
  expect(state.invalidations).toBe(2)
})
