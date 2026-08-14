import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const { createDoc, newFileName, newFileStartPath, planNewFile, readDoc, writeDoc } =
  await import('./docs')
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

describe('planNewFile', () => {
  it('names the folders it would have to create, outermost first', () => {
    const res = planNewFile(dir, 'research/2026/notes.md')
    expect(res).toEqual({
      ok: true,
      plan: {
        path: join(dir, 'research/2026/notes.md'),
        missingDirs: ['research', 'research/2026']
      }
    })
    // nothing was created just by asking
    expect(existsSync(join(dir, 'research'))).toBe(false)
  })

  it('has no folders to report when the parent is already there', () => {
    mkdirSync(join(dir, 'have'), { recursive: true })
    const res = planNewFile(dir, 'have/notes')
    expect(res).toEqual({ ok: true, plan: { path: join(dir, 'have/notes'), missingDirs: [] } })
  })

  it('plans a file with no extension, or a dotfile, like any other', () => {
    expect(planNewFile(dir, 'Makefile')).toEqual({
      ok: true,
      plan: { path: join(dir, 'Makefile'), missingDirs: [] }
    })
    expect(planNewFile(dir, '.gitignore')).toEqual({
      ok: true,
      plan: { path: join(dir, '.gitignore'), missingDirs: [] }
    })
  })

  it('refuses the same things createDoc refuses, before touching the disk', () => {
    writeFileSync(join(dir, 'taken.md'), '# taken\n')
    expect(planNewFile(dir, 'taken.md')).toEqual({ ok: false, error: 'Already exists: taken.md' })
    expect(planNewFile(dir, 'docs/')).toEqual({
      ok: false,
      error: 'Give a file name, e.g. docs/plan.md'
    })
    expect(planNewFile(dir, '../escaped.md')).toEqual({ ok: false, error: 'Outside this project' })
  })

  it('reports a folder outside the cwd by its full path', () => {
    const other = mkdtempSync(join(tmpdir(), 'docs-added-'))
    const res = planNewFile(dir, join(other, 'sub/notes.md'), [other])
    expect(res).toEqual({
      ok: true,
      plan: { path: join(other, 'sub/notes.md'), missingDirs: [join(other, 'sub')] }
    })
    rmSync(other, { recursive: true, force: true })
  })
})

describe('newFileStartPath', () => {
  it('opens the picker next to the file the window has open', () => {
    expect(newFileStartPath('/p', [], '/p/docs')).toBe('/p/docs/untitled.md')
  })

  it('falls back to the project root when there is nowhere better', () => {
    expect(newFileStartPath('/p')).toBe('/p/untitled.md')
    expect(newFileStartPath('/p', [], '')).toBe('/p/untitled.md')
  })

  it('never suggests a folder the window could not open', () => {
    // outside every root — creating there would only earn "Outside this project"
    expect(newFileStartPath('/p', ['/other'], '/elsewhere/tmp')).toBe('/p/untitled.md')
    expect(newFileStartPath('/p', [], '/project-notes')).toBe('/p/untitled.md')
  })

  it('counts an added directory as somewhere to start', () => {
    expect(newFileStartPath('/p', ['/lib'], '/lib/src')).toBe('/lib/src/untitled.md')
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

describe('writeDoc', () => {
  it('overwrites an existing file, and never creates a new one', () => {
    const target = join(dir, 'writable.md')
    writeFileSync(target, 'before', 'utf8')
    expect(writeDoc([dir], target, 'after')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('after')
    expect(writeDoc([dir], join(dir, 'brand-new.md'), 'x')).toBe(false)
    expect(existsSync(join(dir, 'brand-new.md'))).toBe(false)
  })

  it('refuses a path outside every root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'docs-write-outside-'))
    const target = join(outside, 'theirs.md')
    writeFileSync(target, 'theirs', 'utf8')
    expect(writeDoc([dir], target, 'mine')).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('theirs')
    rmSync(outside, { recursive: true, force: true })
  })

  // the pattern list the window edits lives in userData, outside every project
  it('reaches a single file passed as a root, and nothing else beside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'docs-userdata-'))
    const patterns = join(outside, 'config-file-patterns.json')
    writeFileSync(patterns, '{}', 'utf8')
    expect(readDoc([dir], patterns)).toBeNull()
    expect(readDoc([dir, patterns], patterns)).toBe('{}')
    expect(writeDoc([dir, patterns], patterns, '{"include":[]}')).toBe(true)
    // and that root grants nothing else in its folder
    const sibling = join(outside, 'other.json')
    writeFileSync(sibling, '{}', 'utf8')
    expect(readDoc([dir, patterns], sibling)).toBeNull()
    rmSync(outside, { recursive: true, force: true })
  })
})
