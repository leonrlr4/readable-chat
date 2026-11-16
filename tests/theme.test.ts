import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'

import { watchTheme } from '../hooks/render'

function ok(stdout = ''): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// The test $ has no clock, fs or process: the poll runs when the test calls tick(), foot.ini holds `foot`, and the theme
// file's mtime is `mtime`, which leaf-theme.sh would bump when it regenerates the file.
function fakeEngine() {
  const state = { foot: 'background=111111', mtime: '1', invalidations: 0 }
  let poll = () => {}
  const $ = {
    plugin: { root: '/mod' },
    clock: {
      now: async () => Date.now(),
      every: (_ms: number, fn: () => void) => {
        poll = fn
        return { cancel: () => {} }
      },
    },
    fs: {
      read: async (path: string) => {
        if (path.endsWith('/foot.ini')) return state.foot
        throw new Error('missing')
      },
    },
    process: {
      run: async (argv: readonly string[]) => {
        if (argv[0] === 'bash') return ok('--theme\n/cache/omarchy.toml\n')
        if (argv[0] === 'stat') return ok(state.mtime)
        return { ...ok(), exitCode: 1 }
      },
    },
    ui: { invalidate: () => void state.invalidations++ },
  }
  const tick = async () => {
    poll()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { $: $ as never, state, tick }
}

test('a theme switch redraws every reply once, and an unchanged theme never does', async () => {
  const { $, state, tick } = fakeEngine()
  watchTheme($, '/home/me')
  await tick()
  await tick()
  expect(state.invalidations).toBe(0)

  state.foot = 'background=eeeeee'
  state.mtime = '2'
  await tick()
  expect(state.invalidations).toBe(1)
  await tick()
  expect(state.invalidations).toBe(1)
})
