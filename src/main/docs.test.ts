import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const { createDoc, newFileName, readDoc } = await import('./docs')
const { MAX_EDIT_BYTES } = await import('../shared/types')

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

  it('creates into an added directory, which is a root of its own', () => {
    const added = mkdtempSync(join(tmpdir(), 'docs-added-'))
    const res = createDoc(dir, join(added, 'notes.md'), [added])
    expect(res).toEqual({ ok: true, path: join(added, 'notes.md') })
    // …but not when that directory was never added to the session
    expect(createDoc(dir, join(added, 'other.md'))).toEqual({
      ok: false,
      error: 'Outside this project'
    })
    rmSync(added, { recursive: true, force: true })
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

describe('readDoc', () => {
  it('reads a file inside a root, and refuses one outside every root', () => {
    writeFileSync(join(dir, 'readable.md'), 'hello', 'utf8')
    expect(readDoc([dir], join(dir, 'readable.md'))).toBe('hello')
    const outside = mkdtempSync(join(tmpdir(), 'docs-read-outside-'))
    writeFileSync(join(outside, 'secret.md'), 'nope', 'utf8')
    expect(readDoc([dir], join(outside, 'secret.md'))).toBeNull()
    // …until that directory is one of the roots
    expect(readDoc([dir, outside], join(outside, 'secret.md'))).toBe('nope')
    rmSync(outside, { recursive: true, force: true })
  })

  it('holds back a file over the size cap until asked to open it anyway', () => {
    const big = join(dir, 'big.md')
    writeFileSync(big, 'x'.repeat(MAX_EDIT_BYTES + 1), 'utf8')
    expect(readDoc([dir], big)).toBeNull()
    expect(readDoc([dir], big, true)).toHaveLength(MAX_EDIT_BYTES + 1)
  })

  it('is null for a file that does not exist', () => {
    expect(readDoc([dir], join(dir, 'nope.md'))).toBeNull()
  })
})
