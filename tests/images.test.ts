import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'

import { IMAGE_LANG, clearImageCache, extractImages, isBlockedAddress, loadImage, parseHttpsUrl } from '../hooks/images'
import type { ImageEngine } from '../hooks/images'

const PLACES = { cwd: '/work/repo', home: '/home/me' }
const fence = (index: number) => `\`\`\`${IMAGE_LANG}\n${index}\n\`\`\``

test('standalone image paragraph becomes a readable-image fence', () => {
  const { text, images } = extractImages('前文\n\n![截圖](/tmp/a.png)\n\n後文', PLACES)
  expect(text).toBe(`前文\n\n${fence(0)}\n\n後文`)
  expect(images).toEqual([{ kind: 'local', src: '/tmp/a.png', alt: '截圖' }])
})

test('several images on their own lines each get a fence, numbered in order', () => {
  const { text, images } = extractImages('![a](/x/a.png)\n![b](https://example.com/b.png)\n\n![c](c.png)', PLACES)
  expect(text).toBe(`${fence(0)}\n\n${fence(1)}\n\n${fence(2)}`)
  expect(images.map(image => [image.kind, image.src])).toEqual([
    ['local', '/x/a.png'],
    ['remote', 'https://example.com/b.png'],
    ['local', '/work/repo/c.png'],
  ])
})

test('image right under a heading still counts as standalone', () => {
  expect(extractImages('# 結果\n![圖](/a.png)', PLACES).text).toBe(`# 結果\n${fence(0)}`)
})

test('inline image becomes alt plus path, and is not listed', () => {
  const { text, images } = extractImages('請看 ![截圖](./shots/a.png) 這張，還有 ![](https://e.com/x.png)。', PLACES)
  expect(text).toBe('請看 截圖（/work/repo/shots/a.png） 這張，還有 https://e.com/x.png。')
  expect(images).toEqual([])
})

test('code fences and inline code are left alone', () => {
  const source = '```md\n![a](/a.png)\n```\n\n~~~~\n```\n![b](/b.png)\n~~~~\n\n用 `![c](/c.png)` 語法'
  expect(extractImages(source, PLACES)).toEqual({ text: source, images: [] })
})

test('resolves relative, parent, ~/ and file:// sources', () => {
  const { images } = extractImages('![a](../b/a.png)\n![b](~/Pictures/b.png)\n![c](file:///tmp/c%20d.png)\n![d](<my shot.png>)', PLACES)
  expect(images.map(image => image.src)).toEqual(['/work/b/a.png', '/home/me/Pictures/b.png', '/tmp/c d.png', '/work/repo/my shot.png'])
})

test('title attribute is dropped, alt kept', () => {
  const { text, images } = extractImages('![架構](/d/arch.svg "系統架構圖")', PLACES)
  expect(text).toBe(fence(0))
  expect(images).toEqual([{ kind: 'local', src: '/d/arch.svg', alt: '架構' }])
})

test('http is remote (never fetched), data: stays as text', () => {
  const { text, images } = extractImages('![a](http://example.com/a.png)\n\n![b](data:image/png;base64,AAAA)', PLACES)
  expect(images).toEqual([{ kind: 'remote', src: 'http://example.com/a.png', alt: 'a' }])
  expect(text).toBe(`${fence(0)}\n\nb`)
})

test('parses only plain https URLs', () => {
  expect(parseHttpsUrl('https://example.com/a.png?x=1')).toEqual({ host: 'example.com', port: 443 })
  expect(parseHttpsUrl('https://[2001:4860::1]:8443/a')).toEqual({ host: '[2001:4860::1]', port: 8443 })
  expect(parseHttpsUrl('https://example.com@127.0.0.1/a')).toBe(null)
  expect(parseHttpsUrl('https://example.com\\@127.0.0.1/')).toBe(null)
  expect(parseHttpsUrl('http://example.com/a.png')).toBe(null)
})

test('private, loopback, link-local, CGNAT and ULA addresses are blocked', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'garbage']) {
    expect([address, isBlockedAddress(address)]).toEqual([address, true])
  }
  for (const address of ['8.8.8.8', '20.27.177.113', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    expect([address, isBlockedAddress(address)]).toEqual([address, false])
  }
})

// PNG header for 640×352 (the content is one pixel; only IHDR is read).
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAoAAAAFgCAYAAAArYcg8AAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
const CACHE = '/home/me/.cache/readable-chat/images'
const DIGEST = 'a'.repeat(64)

function result(exitCode: number, stdout = ''): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// Fake host: files maps a path to its `stat` line; every argv is recorded.
function fakeEngine(files: Record<string, string>, respond: (argv: readonly string[]) => ProcessRunResult | undefined = () => undefined) {
  const runs: (readonly string[])[] = []
  const reads: string[] = []
  const $: ImageEngine = {
    process: {
      run: async argv => {
        runs.push(argv)
        const custom = respond(argv)
        if (custom) return custom
        if (argv[0] === 'stat') {
          const line = files[argv.at(-1) ?? '']
          return line ? result(0, `${line}\n`) : result(1)
        }
        if (argv[0] === 'sh') return result(0, CACHE)
        if (argv[0] === 'sha256sum') return result(0, `${DIGEST}  -\n`)
        if (argv[0] === 'file') return result(0, 'image/png\n')
        if (argv[0] === 'magick' && argv[1] === 'identify') return result(0, '640 352\n')
        if (argv[0] === 'magick') {
          // The converted file now exists, small enough to keep.
          const output = (argv.at(-1) ?? '').replace(/^PNG:/, '')
          files[output] = 'regular file\t5000\t1'
          return result(0)
        }
        return result(0)
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

const OPTIONS = { columns: 50, maxRows: 20, allowRemote: false }

test('loadImage: local PNG is converted into the cache and read back as base64', async () => {
  clearImageCache()
  const { $, runs, reads } = fakeEngine({ '/pics/a.png': 'regular file\t12345\t1700000000' })
  const ref = { kind: 'local' as const, src: '/pics/a.png', alt: '截圖' }
  const image = await loadImage($, ref, OPTIONS)
  // 640×352 px at 10×22 per cell: 64 natural columns, capped to 50; 50 × 352/640 × 10/22 ≈ 13 rows.
  expect(image).toEqual({ ok: true, source: { png: PNG_BASE64 }, columns: 50, rows: 13, alt: '截圖' })
  const convert = runs.find(argv => argv[0] === 'magick' && argv[1] !== 'identify') ?? []
  expect(convert.slice(0, 5)).toEqual(['magick', 'PNG:/pics/a.png[0]', '-auto-orient', '-resize', '1600x>'])
  expect(runs.find(argv => argv[0] === 'mv')).toEqual(['mv', '-f', '--', convert.at(-1)?.replace(/^PNG:/, ''), `${CACHE}/${DIGEST}.png`])
  expect(reads).toEqual([`${CACHE}/${DIGEST}.png`])

  // Same ref and options come from memory without running anything.
  const count = runs.length
  expect(await loadImage($, ref, OPTIONS)).toBe(image)
  expect(runs.length).toBe(count)
})

test('loadImage: BSD stat (macOS) reads the file after GNU --format is refused', async () => {
  clearImageCache()
  const files: Record<string, string> = { '/pics/a.png': 'Regular File\t12345\t1700000000' }
  const { $, runs } = fakeEngine(files, argv => {
    if (argv[0] !== 'stat') return undefined
    if (argv.some(arg => arg.startsWith('--format'))) return { ...result(1), stderr: 'stat: illegal option -- -' }
    const line = files[argv.at(-1) ?? '']
    return line ? result(0, `${line}\n`) : result(1)
  })
  expect((await loadImage($, { kind: 'local', src: '/pics/a.png', alt: '截圖' }, OPTIONS)).ok).toBe(true)
  expect(runs.find(argv => argv[0] === 'stat' && argv.includes('-f'))).toEqual(['stat', '-L', '-f', '%HT%t%z%t%m', '--', '/pics/a.png'])
})

test('loadImage: a missing file on GNU stat does not try the BSD form', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({})
  expect((await loadImage($, { kind: 'local', src: '/pics/none.png', alt: '' }, OPTIONS)).ok).toBe(false)
  expect(runs.filter(argv => argv[0] === 'stat')).toHaveLength(1)
})

test('loadImage: small image is never scaled up', async () => {
  clearImageCache()
  const { $ } = fakeEngine({ '/pics/a.png': 'regular file\t100\t1' })
  const image = await loadImage($, { kind: 'local', src: '/pics/a.png', alt: '' }, { ...OPTIONS, columns: 200 })
  expect(image.ok && [image.columns, image.rows]).toEqual([64, 16])
})

test('loadImage: cached PNG on disk skips conversion', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({ '/pics/a.png': 'regular file\t1\t1', [`${CACHE}/${DIGEST}.png`]: 'regular file\t5000\t1' })
  expect((await loadImage($, { kind: 'local', src: '/pics/a.png', alt: '' }, OPTIONS)).ok).toBe(true)
  expect(runs.some(argv => argv[0] === 'magick')).toBe(false)
})

test('loadImage: oversized PNG is shrunk further until it fits 2 MiB', async () => {
  clearImageCache()
  let passes = 0
  const files: Record<string, string> = { '/pics/big.png': 'regular file\t9000000\t1' }
  const { $, runs } = fakeEngine(files, argv => {
    if (argv[0] === 'magick' && argv[1] !== 'identify') {
      passes++
      files[(argv.at(-1) ?? '').replace(/^PNG:/, '')] = `regular file\t${passes < 3 ? 3000000 : 1000000}\t1`
      return result(0)
    }
    return undefined
  })
  expect((await loadImage($, { kind: 'local', src: '/pics/big.png', alt: '' }, OPTIONS)).ok).toBe(true)
  const widths = runs.filter(argv => argv[0] === 'magick' && argv[1] !== 'identify').map(argv => argv[4])
  expect(widths).toEqual(['1600x>', '1200x>', '900x>'])
})

test('loadImage: missing file, directory and unknown format fail with a reason', async () => {
  clearImageCache()
  const { $ } = fakeEngine({ '/pics/dir': 'directory\t4096\t1', '/pics/a.txt': 'regular file\t10\t1' }, argv =>
    argv[0] === 'file' && argv.at(-1) === '/pics/a.txt' ? result(0, 'text/plain\n') : undefined,
  )
  expect(await loadImage($, { kind: 'local', src: '/pics/none.png', alt: '圖' }, OPTIONS)).toEqual({ ok: false, reason: '檔案不存在', alt: '圖' })
  expect(await loadImage($, { kind: 'local', src: '/pics/dir', alt: '' }, OPTIONS)).toEqual({ ok: false, reason: '不是一般檔案', alt: '' })
  expect(await loadImage($, { kind: 'local', src: '/pics/a.txt', alt: '' }, OPTIONS)).toEqual({ ok: false, reason: '不支援的格式', alt: '' })
})

test('loadImage: a throwing host resolves to ok:false', async () => {
  clearImageCache()
  const $: ImageEngine = {
    process: { run: async () => Promise.reject(new Error('spawn stat ENOENT')) },
    fs: { read: async () => ({ base64: PNG_BASE64 }) },
  }
  expect(await loadImage($, { kind: 'local', src: '/a.png', alt: 'x' }, OPTIONS)).toEqual({ ok: false, reason: '無法載入', alt: 'x' })
})

test('loadImage: mermaid and math refs are not handled here', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({})
  expect(await loadImage($, { kind: 'math', src: 'x^2', alt: '' }, OPTIONS)).toEqual({ ok: false, reason: '不支援', alt: '' })
  expect(runs).toEqual([])
})

test('loadImage: remote off never touches the network', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({})
  const image = await loadImage($, { kind: 'remote', src: 'https://example.com/a.png', alt: 'a' }, OPTIONS)
  expect(image).toEqual({ ok: false, reason: '遠端圖片未開啟，/images remote on 打開', alt: 'a' })
  expect(runs).toEqual([])
})

test('loadImage: http is refused even with remote on', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({})
  const image = await loadImage($, { kind: 'remote', src: 'http://example.com/a.png', alt: '' }, { ...OPTIONS, allowRemote: true })
  expect(image).toEqual({ ok: false, reason: '只抓 https 圖片', alt: '' })
  expect(runs.some(argv => argv[0] === 'curl')).toBe(false)
})

test('loadImage: host resolving to a private address is rejected before curl', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({}, argv =>
    argv[0] === 'getent' ? result(0, '93.184.216.34   STREAM evil.example\n10.0.0.5        STREAM\n') : undefined,
  )
  const image = await loadImage($, { kind: 'remote', src: 'https://evil.example/a.png', alt: '' }, { ...OPTIONS, allowRemote: true })
  expect(image).toEqual({ ok: false, reason: '拒絕內網位址', alt: '' })
  expect(runs.some(argv => argv[0] === 'curl')).toBe(false)
})

test('loadImage: redirect to a private host is checked and rejected', async () => {
  clearImageCache()
  const { $, runs } = fakeEngine({}, argv => {
    if (argv[0] === 'getent') return result(0, argv[2] === 'cdn.example' ? '93.184.216.34 STREAM cdn.example\n' : '127.0.0.1 STREAM\n')
    if (argv[0] === 'curl') return result(0, '302\nhttps://internal.example/secret.png')
    return undefined
  })
  const image = await loadImage($, { kind: 'remote', src: 'https://cdn.example/a.png', alt: '' }, { ...OPTIONS, allowRemote: true })
  expect(image).toEqual({ ok: false, reason: '拒絕內網位址', alt: '' })
  const curl = runs.filter(argv => argv[0] === 'curl')
  expect(curl.length).toBe(1)
  expect(curl[0]?.includes('-L')).toBe(false)
  const pin = curl[0]?.indexOf('--resolve') ?? -1
  expect(curl[0]?.[pin + 1]).toBe('cdn.example:443:93.184.216.34')
})

test('loadImage: remote PNG is fetched, sniffed and converted', async () => {
  clearImageCache()
  const files: Record<string, string> = {}
  const { $ } = fakeEngine(files, argv => {
    if (argv[0] === 'getent') return result(0, '93.184.216.34 STREAM cdn.example\n')
    if (argv[0] === 'curl') {
      files[argv[argv.indexOf('--output') + 1] ?? ''] = 'regular file\t40000\t1'
      return result(0, '200\n')
    }
    return undefined
  })
  const image = await loadImage($, { kind: 'remote', src: 'https://cdn.example/a.png', alt: 'a' }, { ...OPTIONS, allowRemote: true })
  expect(image.ok).toBe(true)
})

test('loadImage: remote SVG is refused by its bytes', async () => {
  clearImageCache()
  const files: Record<string, string> = {}
  const { $ } = fakeEngine(files, argv => {
    if (argv[0] === 'getent') return result(0, '93.184.216.34 STREAM cdn.example\n')
    if (argv[0] === 'curl') {
      files[argv[argv.indexOf('--output') + 1] ?? ''] = 'regular file\t400\t1'
      return result(0, '200\n')
    }
    if (argv[0] === 'file') return result(0, 'image/svg+xml\n')
    return undefined
  })
  const image = await loadImage($, { kind: 'remote', src: 'https://cdn.example/a.png', alt: '' }, { ...OPTIONS, allowRemote: true })
  expect(image).toEqual({ ok: false, reason: '不支援的格式', alt: '' })
})
