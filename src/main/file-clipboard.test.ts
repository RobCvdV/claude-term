import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() } }))
const { freeName, pasteFiles } = await import('./file-clipboard')

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'paste-'))
  mkdirSync(join(dir, 'src/sub'), { recursive: true })
  writeFileSync(join(dir, 'a.ts'), 'a')
  writeFileSync(join(dir, 'src/sub/b.ts'), 'b')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('freeName', () => {
  const taken = (names: string[]) => (p: string) => names.some((n) => p.endsWith('/' + n))

  it('keeps a free name', () => {
    expect(freeName('/x', 'a.ts', taken([]))).toBe('a.ts')
  })

  it('counts up the way Finder does', () => {
    expect(freeName('/x', 'a.ts', taken(['a.ts']))).toBe('a copy.ts')
    expect(freeName('/x', 'a.ts', taken(['a.ts', 'a copy.ts']))).toBe('a copy 2.ts')
    expect(freeName('/x', '.env', taken(['.env']))).toBe('.env copy')
    expect(freeName('/x', 'src', taken(['src']))).toBe('src copy')
  })
})

describe('pasteFiles', () => {
  it('copies a file next to itself under a free name', () => {
    const r = pasteFiles([dir], dir, [join(dir, 'a.ts')])
    expect(r).toEqual({ ok: true, paths: [join(dir, 'a copy.ts')] })
    expect(readFileSync(join(dir, 'a copy.ts'), 'utf8')).toBe('a')
  })

  it('copies a folder with its contents', () => {
    const r = pasteFiles([dir], dir, [join(dir, 'src/sub')])
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'sub/b.ts'))).toBe(true)
  })

  it('refuses a folder into itself, a target outside the roots, and an empty clipboard', () => {
    expect(pasteFiles([dir], join(dir, 'src/sub'), [join(dir, 'src')]).ok).toBe(false)
    expect(pasteFiles([join(dir, 'src')], dir, [join(dir, 'a.ts')]).ok).toBe(false)
    expect(pasteFiles([dir], dir, [])).toEqual({ ok: false, error: 'No files on the clipboard' })
  })
})
