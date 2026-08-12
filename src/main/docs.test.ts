import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const { createDoc, newFileName } = await import('./docs')

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docs-test-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('newFileName', () => {
  it('takes the name exactly as typed, whatever the extension', () => {
    expect(newFileName('docs/plan.md')).toBe('docs/plan.md')
    expect(newFileName('  notes.txt  ')).toBe('notes.txt')
    expect(newFileName('src/thing.ts')).toBe('src/thing.ts')
  })

  it('accepts a name with no extension, and a bare dotfile', () => {
    expect(newFileName('docs/plan')).toBe('docs/plan')
    expect(newFileName('Makefile')).toBe('Makefile')
    expect(newFileName('.gitignore')).toBe('.gitignore')
  })

  it('refuses anything that names no file', () => {
    expect(newFileName('')).toBeNull()
    expect(newFileName('   ')).toBeNull()
    expect(newFileName('docs/')).toBeNull()
    expect(newFileName('..')).toBeNull()
  })
})

describe('createDoc', () => {
  it('seeds a markdown file with a heading from its name', () => {
    const res = createDoc(dir, 'plan-of-attack.md')
    expect(res).toEqual({ ok: true, path: join(dir, 'plan-of-attack.md') })
    expect(readFileSync(join(dir, 'plan-of-attack.md'), 'utf8')).toBe('# Plan of attack\n\n')
  })

  it('creates any other text file empty', () => {
    for (const name of ['.gitignore', 'Makefile', 'notes', 'src/thing.ts']) {
      const res = createDoc(dir, name)
      expect(res).toEqual({ ok: true, path: join(dir, name) })
      expect(readFileSync(join(dir, name), 'utf8')).toBe('')
    }
  })

  it('creates missing parent folders', () => {
    const res = createDoc(dir, 'docs/deep/nested/notes.md')
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, 'docs/deep/nested/notes.md'))).toBe(true)
  })

  it('never touches an existing file', () => {
    writeFileSync(join(dir, 'taken.md'), 'mine', 'utf8')
    const res = createDoc(dir, 'taken.md')
    expect(res.ok).toBe(false)
    expect(readFileSync(join(dir, 'taken.md'), 'utf8')).toBe('mine')
  })

  it('refuses a path outside the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'docs-outside-'))
    mkdirSync(join(dir, 'sub'), { recursive: true })
    for (const arg of ['../escape.md', join(outside, 'escape.md'), 'sub/../../escape.md']) {
      expect(createDoc(dir, arg)).toEqual({ ok: false, error: 'Outside this project' })
    }
    expect(existsSync(join(outside, 'escape.md'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses an argument that names no file', () => {
    for (const arg of ['', 'sub/']) {
      expect(createDoc(dir, arg)).toEqual({
        ok: false,
        error: 'Give a file name, e.g. docs/plan.md'
      })
    }
  })
})
