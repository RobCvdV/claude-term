import { describe, expect, it } from 'vitest'
import { contentOf, isDirty, keepsDraft, reselect, shownText } from './file-editor-state'

describe('contentOf', () => {
  it('gives the open file its own text', () => {
    expect(contentOf({ path: '/a.md', text: 'hello' }, '/a.md')).toBe('hello')
  })

  it('never shows another file’s text while the new one loads', () => {
    expect(contentOf({ path: '/a.md', text: 'hello' }, '/b.md')).toBeNull()
  })

  it('is null before anything has loaded, and with nothing selected', () => {
    expect(contentOf(null, '/a.md')).toBeNull()
    expect(contentOf({ path: '/a.md', text: 'hello' }, undefined)).toBeNull()
  })

  it('passes an unreadable file through as null', () => {
    expect(contentOf({ path: '/a.md', text: null }, '/a.md')).toBeNull()
  })

  it('treats an empty file as content, not as still-loading', () => {
    // a just-created file is empty; the editor must still open on it
    expect(contentOf({ path: '/new.md', text: '' }, '/new.md')).toBe('')
  })
})

describe('shownText', () => {
  it('prefers the draft, falling back to disk', () => {
    expect(shownText('typed', 'ondisk')).toBe('typed')
    expect(shownText(null, 'ondisk')).toBe('ondisk')
    expect(shownText(null, null)).toBeNull()
  })

  it('shows a draft that was emptied, rather than falling back to disk', () => {
    expect(shownText('', 'ondisk')).toBe('')
  })
})

describe('isDirty', () => {
  it('is dirty only when a draft differs from disk', () => {
    expect(isDirty(null, 'ondisk')).toBe(false)
    expect(isDirty('ondisk', 'ondisk')).toBe(false)
    expect(isDirty('typed', 'ondisk')).toBe(true)
  })

  it('clears once the draft has been written back as the baseline', () => {
    const draft = 'edited'
    expect(isDirty(draft, 'ondisk')).toBe(true)
    expect(isDirty(draft, draft)).toBe(false)
  })

  it('counts emptying a file as an edit', () => {
    expect(isDirty('', 'ondisk')).toBe(true)
  })
})

describe('keepsDraft', () => {
  it('keeps a draft when the same file is re-selected', () => {
    expect(keepsDraft('/a.md', '/a.md')).toBe(true)
  })

  it('drops it when moving to another file, so it cannot be saved there', () => {
    expect(keepsDraft('/a.md', '/b.md')).toBe(false)
    expect(keepsDraft(undefined, '/b.md')).toBe(false)
    expect(keepsDraft('/a.md', undefined)).toBe(false)
  })
})

describe('reselect', () => {
  const entries = [{ path: '/a.md' }, { path: '/b.md' }]

  it('keeps the file that was open across a re-scan', () => {
    expect(reselect(entries, '/b.md')).toEqual({ path: '/b.md' })
  })

  it('falls back to the first when the open file is gone or none was open', () => {
    expect(reselect(entries, '/deleted.md')).toEqual({ path: '/a.md' })
    expect(reselect(entries, undefined)).toEqual({ path: '/a.md' })
  })

  it('selects nothing when the listing is empty', () => {
    expect(reselect([], '/a.md')).toBeNull()
    expect(reselect([], undefined)).toBeNull()
  })
})
