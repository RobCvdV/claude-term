import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isBinaryName, searchContents, searchFile } from './content-search'

let root: string
// files only searchFile reads, kept out of the tree searchContents lists
let scratch: string

const write = (rel: string, data: string | Buffer, dir = root): string => {
  const path = join(dir, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
  return path
}

const re = (q: string): RegExp => new RegExp(q, 'gi')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'grep-root-'))
  scratch = mkdtempSync(join(tmpdir(), 'grep-scratch-'))
  write('README.md', '# Title\nsome Needle here\nnothing\n')
  write('src/a.ts', 'const x = 1\n// needle and needle again\n')
  write('config.json', '{ "needle": true }')
  write('icon.svg', '<svg><title>needle</title></svg>')
  write('logo.png', 'needle — but a png is never text')
  write('regex.txt', 'a.b\naxb\n')
  write('blob', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

describe('isBinaryName', () => {
  it('knows images, audio and archives, and leaves text types alone', () => {
    for (const n of ['a.PNG', 'x/song.mp3', 'b.zip', 'font.woff2', 'doc.pdf'])
      expect(isBinaryName(n)).toBe(true)
    for (const n of ['a.svg', 'b.xml', 'c.json', 'Makefile', '.env', 'notes'])
      expect(isBinaryName(n)).toBe(false)
  })
})

describe('searchFile', () => {
  it('reports line, column and a preview with the match located in it', async () => {
    const hits = await searchFile(join(root, 'README.md'), re('needle'), 10)
    expect(hits).toEqual([
      { line: 2, column: 6, length: 6, preview: 'some Needle here', previewAt: 5 }
    ])
  })

  it('takes only the first match on a line', async () => {
    const hits = await searchFile(join(root, 'src/a.ts'), re('needle'), 10)
    expect(hits?.map((h) => [h.line, h.column])).toEqual([[2, 4]])
  })

  it('is null for a file with a NUL byte, whatever its name', async () => {
    expect(await searchFile(join(root, 'blob'), re('needle'), 10)).toBeNull()
  })

  it('finds matches across chunk edges, with the right line numbers', async () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      i % 7 === 3 ? `line ${i} has needle` : `line ${i}`
    )
    const path = write('chunked.txt', lines.join('\n'), scratch)
    const hits = await searchFile(path, re('needle'), 100, undefined, 16)
    const want = lines.flatMap((l, i) => (l.includes('needle') ? [i + 1] : []))
    expect(hits?.map((h) => h.line)).toEqual(want)
    expect(hits?.every((h) => h.preview.slice(h.previewAt, h.previewAt + 6) === 'needle')).toBe(
      true
    )
  })

  it('keeps multi-byte characters whole across a chunk edge', async () => {
    const path = write('utf8.txt', 'ééééééé needle\n', scratch)
    const hits = await searchFile(path, re('needle'), 10, undefined, 5)
    expect(hits?.[0]).toMatchObject({ line: 1, column: 9 })
  })

  it('searches a line far longer than it keeps, column counted from its start', async () => {
    const pad = 'x'.repeat(200 * 1024)
    const path = write('min.js', `${pad}needle${pad}\nsecond needle\n`, scratch)
    const hits = await searchFile(path, re('needle'), 10)
    expect(hits?.map((h) => [h.line, h.column])).toEqual([
      [1, pad.length + 1],
      [2, 8]
    ])
  })

  it('stops at the hit limit', async () => {
    const path = write('many.txt', 'needle\n'.repeat(100), scratch)
    expect(await searchFile(path, re('needle'), 5)).toHaveLength(5)
  })
})

describe('searchContents', () => {
  it('finds text files only, sorted by path, matching case-insensitively', async () => {
    const res = await searchContents([root], 'NEEDLE')
    expect(res.matches.map((m) => m.name)).toEqual([
      'config.json',
      'icon.svg',
      'README.md',
      'src/a.ts'
    ])
    expect(res.matches.find((m) => m.name === 'config.json')?.path).toBe(join(root, 'config.json'))
  })

  it('takes the query literally', async () => {
    const res = await searchContents([root], 'a.b')
    expect(res.matches.find((m) => m.name === 'regex.txt')?.hits.map((h) => h.line)).toEqual([1])
  })

  it('is empty for a blank query, and for a root that cannot be read', async () => {
    expect((await searchContents([root], '  ')).matches).toEqual([])
    expect((await searchContents([join(root, 'gone')], 'needle')).matches).toEqual([])
  })

  it('stops early once cancelled', async () => {
    const res = await searchContents([root], 'needle', () => true)
    expect(res.matches).toEqual([])
  })
})
