import { describe, expect, it } from 'vitest'
import { matchesFilter } from './glob-match'

describe('matchesFilter', () => {
  it('matches plain text anywhere in the path', () => {
    expect(matchesFilter('plan', 'docs/plan-of-attack.md')).toBe(true)
    expect(matchesFilter('docs', 'docs/plan.md')).toBe(true)
    expect(matchesFilter('nope', 'docs/plan.md')).toBe(false)
  })

  it('ignores case and surrounding spaces', () => {
    expect(matchesFilter('  PLAN  ', 'docs/plan.md')).toBe(true)
    expect(matchesFilter('README', 'readme.md')).toBe(true)
  })

  it('matches everything for an empty query', () => {
    expect(matchesFilter('', 'anything')).toBe(true)
    expect(matchesFilter('   ', 'anything')).toBe(true)
  })

  it('treats * as a pattern over the whole path', () => {
    expect(matchesFilter('*.md', 'docs/plan.md')).toBe(true)
    expect(matchesFilter('*.md', 'docs/plan.txt')).toBe(false)
    expect(matchesFilter('docs/*', 'docs/plan.md')).toBe(true)
    expect(matchesFilter('docs/*', 'src/plan.md')).toBe(false)
  })

  it('also matches a pattern against the file name alone', () => {
    // "plan*" is about the file, not the folders above it
    expect(matchesFilter('plan*', 'docs/deep/plan-b.md')).toBe(true)
    expect(matchesFilter('plan*', 'docs/deep/notes.md')).toBe(false)
  })

  it('anchors a pattern, unlike a plain query', () => {
    expect(matchesFilter('plan', 'docs/my-plan.md')).toBe(true)
    expect(matchesFilter('plan*', 'docs/my-plan.md')).toBe(false)
    expect(matchesFilter('*plan*', 'docs/my-plan.md')).toBe(true)
  })

  it('matches one character with ?', () => {
    expect(matchesFilter('v?.md', 'docs/v2.md')).toBe(true)
    expect(matchesFilter('v?.md', 'docs/v22.md')).toBe(false)
  })

  it('finds a file with no extension at all', () => {
    expect(matchesFilter('notes', 'docs/notes')).toBe(true)
    expect(matchesFilter('*notes', 'docs/notes')).toBe(true)
    expect(matchesFilter('Makefile', 'Makefile')).toBe(true)
  })

  it('takes the rest of the query literally, dots included', () => {
    expect(matchesFilter('*.md', 'docs/plan-md')).toBe(false)
    expect(matchesFilter('a+b*', 'a+b.txt')).toBe(true)
    expect(matchesFilter('(x)*', '(x).txt')).toBe(true)
  })
})
