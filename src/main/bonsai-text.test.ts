import { describe, expect, it } from 'vitest'
import { clipForModel, sanitizeOneLiner } from './bonsai-text'

describe('sanitizeOneLiner', () => {
  it('collapses whitespace and newlines to one line', () => {
    expect(sanitizeOneLiner('fixing  the\n  parser\n')).toBe('fixing the parser')
  })

  it('strips wrapping quotes and label prefixes', () => {
    expect(sanitizeOneLiner('"Summary: refactoring the queue"')).toBe('refactoring the queue')
  })

  it('truncates to maxLen with an ellipsis', () => {
    const out = sanitizeOneLiner('a'.repeat(300), 120)
    expect(out).toHaveLength(120)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('returns null for empty or quote-only input', () => {
    expect(sanitizeOneLiner(null)).toBeNull()
    expect(sanitizeOneLiner('   ')).toBeNull()
    expect(sanitizeOneLiner('""')).toBeNull()
  })
})

describe('clipForModel', () => {
  it('keeps the end of long text', () => {
    const clipped = clipForModel('x'.repeat(3000) + 'END', 100)
    expect(clipped).toHaveLength(100)
    expect(clipped.endsWith('END')).toBe(true)
  })

  it('passes short text through', () => {
    expect(clipForModel('short')).toBe('short')
  })
})
