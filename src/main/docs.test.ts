import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

const { createDoc, normalizeDocName } = await import('./docs')

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docs-test-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('normalizeDocName', () => {
  it('keeps a .md name as typed', () => {
    expect(normalizeDocName('docs/plan.md')).toBe('docs/plan.md')
    expect(normalizeDocName('  notes.MD  ')).toBe('notes.MD')
  })

  it('adds .md to an extension-less name', () => {
    expect(normalizeDocName('docs/plan')).toBe('docs/plan.md')
    expect(normalizeDocName('research/v1.2/plan')).toBe('research/v1.2/plan.md')
  })

  it('refuses anything that is not a markdown file', () => {
    expect(normalizeDocName('notes.txt')).toBeNull()
    expect(normalizeDocName('')).toBeNull()
    expect(normalizeDocName('docs/')).toBeNull()
  })
})

describe('createDoc', () => {
  it('creates the file, seeded with a heading from its name', () => {
    const res = createDoc(dir, 'plan-of-attack.md')
    expect(res).toEqual({ ok: true, path: join(dir, 'plan-of-attack.md') })
    expect(readFileSync(join(dir, 'plan-of-attack.md'), 'utf8')).toBe('# Plan of attack\n\n')
  })

  it('creates missing parent folders', () => {
    const res = createDoc(dir, 'docs/deep/nested/notes')
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

  it('refuses a non-markdown name', () => {
    const res = createDoc(dir, 'script.sh')
    expect(res.ok).toBe(false)
    expect(existsSync(join(dir, 'script.sh'))).toBe(false)
  })
})
