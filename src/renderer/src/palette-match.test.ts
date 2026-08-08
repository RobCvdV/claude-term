import { describe, expect, it } from 'vitest'
import { bestScore, matchScore } from './palette-match'

describe('matchScore', () => {
  it('matches subsequences case-insensitively, rejects non-subsequences', () => {
    expect(matchScore('crd', 'Cross Dock')).not.toBeNull()
    expect(matchScore('xyz', 'Cross Dock')).toBeNull()
    // in-order requirement: chars must appear in query order
    expect(matchScore('kd', 'dock')).toBeNull()
  })

  it('empty query matches everything neutrally', () => {
    expect(matchScore('', 'anything')).toBe(0)
  })

  it('ranks a word-start acronym above scattered letters', () => {
    const acronym = matchScore('mt', 'mendrix-tms')! // word starts: m…t
    const scattered = matchScore('mt', 'important')! // mid-word letters
    expect(acronym).toBeGreaterThan(scattered)
  })

  it('ranks an adjacent pair above a spread-out pair on the same target', () => {
    const adjacent = matchScore('do', 'dock')!
    const spread = matchScore('dk', 'dock')!
    expect(adjacent).toBeGreaterThan(spread)
  })

  it('prefers the shorter target on otherwise equal matches', () => {
    const short = matchScore('tms', 'tms')!
    const long = matchScore('tms', 'tms-playground-archive')!
    expect(short).toBeGreaterThan(long)
  })
})

describe('bestScore', () => {
  it('takes the best field and skips empties', () => {
    expect(bestScore('feat', [undefined, 'main', 'feature/MTX-1-x'])).toBe(
      matchScore('feat', 'feature/MTX-1-x')
    )
    expect(bestScore('zz', ['main', undefined])).toBeNull()
  })
})
