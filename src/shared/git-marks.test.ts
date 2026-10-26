import { describe, expect, it } from 'vitest'
import { markFor } from './git-marks'
import type { GitMarks } from './types'

const marks: GitMarks = {
  exact: {
    '/r/src/a.ts': 'modified',
    '/r/dist': 'ignored',
    '/r/new': 'untracked',
    '/r/src/b.ts': 'added'
  },
  dirty: ['/r', '/r/src']
}
const dirty = new Set(marks.dirty)

describe('markFor', () => {
  it('uses a file’s own status', () => {
    expect(markFor(marks, dirty, '/r/src/a.ts', false)).toBe('modified')
    expect(markFor(marks, dirty, '/r/src/b.ts', false)).toBe('added')
  })

  it('inherits an ignored or untracked folder’s status', () => {
    expect(markFor(marks, dirty, '/r/dist/x/y.js', false)).toBe('ignored')
    expect(markFor(marks, dirty, '/r/new/sub', true)).toBe('untracked')
  })

  it('marks a folder holding changes as modified', () => {
    expect(markFor(marks, dirty, '/r/src', true)).toBe('modified')
    expect(markFor(marks, dirty, '/r/docs', true)).toBeUndefined()
  })

  it('leaves clean files unmarked', () => {
    expect(markFor(marks, dirty, '/r/src/c.ts', false)).toBeUndefined()
    expect(markFor(null, dirty, '/r/src/a.ts', false)).toBeUndefined()
  })
})
