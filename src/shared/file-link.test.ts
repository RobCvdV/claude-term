import { describe, expect, it } from 'vitest'
import { findFileLinks, parseFileLink } from './file-link'

const paths = (text: string): string[] => findFileLinks(text).map((l) => `${l.path}:${l.line}`)

describe('findFileLinks', () => {
  it('finds a project-relative path with a line', () => {
    expect(findFileLinks('see src/main/ipc.ts:403 for the handler')).toEqual([
      {
        raw: 'src/main/ipc.ts:403',
        path: 'src/main/ipc.ts',
        line: 403,
        column: undefined,
        start: 4,
        end: 23
      }
    ])
  })

  it('takes a column when one is printed', () => {
    const [hit] = findFileLinks('tsconfig.web.json:12:5 - error TS5102')
    expect(hit).toMatchObject({ path: 'tsconfig.web.json', line: 12, column: 5 })
  })

  it('accepts absolute, home and dot-relative paths', () => {
    expect(paths('/Users/rob/x/y.ts:1')).toEqual(['/Users/rob/x/y.ts:1'])
    expect(paths('~/dev/notes.md:22')).toEqual(['~/dev/notes.md:22'])
    expect(paths('./scripts/build.mjs:3')).toEqual(['./scripts/build.mjs:3'])
    expect(paths('../shared/types.ts:9')).toEqual(['../shared/types.ts:9'])
  })

  it('accepts a bare filename only when it looks like a file', () => {
    expect(paths('App.tsx:747')).toEqual(['App.tsx:747'])
    expect(paths('./Makefile:12')).toEqual(['./Makefile:12'])
    // no slash and no extension — as likely a log prefix as a file
    expect(paths('worker:12')).toEqual([])
  })

  it('finds a dotfile directory', () => {
    expect(paths('.claude/settings.json:5')).toEqual(['.claude/settings.json:5'])
  })

  it('finds several links in one line', () => {
    expect(paths('a/b.ts:1 and c/d.ts:2')).toEqual(['a/b.ts:1', 'c/d.ts:2'])
  })

  it('leaves urls alone', () => {
    expect(paths('http://localhost:5199/ and https://x.dev:443/a/b.ts')).toEqual([])
    expect(paths('ws://127.0.0.1:9231/devtools/page/AB12')).toEqual([])
  })

  it('is not fooled by versions, times or bare numbers', () => {
    expect(paths('v1.34.0:12')).toEqual([])
    expect(paths('started at 14:00:55')).toEqual([])
    expect(paths('127.0.0.1:9231')).toEqual([])
    expect(paths('ratio 3:2')).toEqual([])
  })

  it('does not start a match in the middle of a longer path', () => {
    expect(paths('/Users/rob/Dev/claude-term/src/App.tsx:5')).toEqual([
      '/Users/rob/Dev/claude-term/src/App.tsx:5'
    ])
  })

  it('stops at punctuation that ends a sentence', () => {
    const [hit] = findFileLinks('fixed in src/a.ts:12.')
    expect(hit.raw).toBe('src/a.ts:12')
  })

  it('finds a link inside quotes and parentheses', () => {
    expect(paths('"src/a.ts:1" (src/b.ts:2)')).toEqual(['src/a.ts:1', 'src/b.ts:2'])
  })

  it('needs a line number', () => {
    expect(paths('src/main/ipc.ts')).toEqual([])
  })
})

describe('parseFileLink', () => {
  it('parses a whole string, trimming it', () => {
    expect(parseFileLink('  src/a.ts:42:7  ')).toEqual({
      path: 'src/a.ts',
      line: 42,
      column: 7
    })
  })

  it('rejects a string that merely contains a link', () => {
    expect(parseFileLink('see src/a.ts:42')).toBeNull()
  })
})
