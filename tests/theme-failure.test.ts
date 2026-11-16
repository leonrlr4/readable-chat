import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'

import { renderWithLeaf } from '../hooks/render'

function result(exitCode: number, stdout = ''): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

test('a failed theme run is retried and its unthemed lines are not cached', async () => {
  const state = { now: 0, isThemeOk: false, leafArgs: [] as string[][], invalidations: 0 }
  const $ = {
    plugin: { root: '/mod' },
    clock: { now: async () => state.now },
    process: {
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'bash') return state.isThemeOk ? result(0, '--theme\n/cache/omarchy.toml\n') : result(1)
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

  await renderWithLeaf($, '某段文字', 40)
  expect(state.leafArgs.at(-1)).not.toContain('--theme')

  state.isThemeOk = true
  state.now = 2500
  await renderWithLeaf($, '某段文字', 40)
  expect(state.leafArgs).toHaveLength(2)
  expect(state.leafArgs.at(-1)).toContain('--theme')
  expect(state.invalidations).toBe(1)

  // A later failure keeps the theme it had.
  state.isThemeOk = false
  state.now = 60_000
  await renderWithLeaf($, '另一段', 40)
  expect(state.leafArgs.at(-1)).toContain('--theme')
})
