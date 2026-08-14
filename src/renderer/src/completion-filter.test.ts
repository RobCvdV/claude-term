import { describe, expect, it } from 'vitest'
import { filterFor } from './completion-filter'

describe('filterFor', () => {
  it('leaves a suggestion that already starts with what was typed', () => {
    expect(filterFor('Dev/mend', 'Dev/mendrix-tms/')).toBe('Dev/mendrix-tms/')
    expect(filterFor('', 'anything/')).toBe('anything/')
  })

  it('keeps a home-relative query matching its absolute answer', () => {
    // the bug: monaco scored "/Users/rob/Dev/" against "~/Dev" and dropped it
    const kept = filterFor('~/Dev', '/Users/rob/Dev/')
    expect(kept.startsWith('~/Dev')).toBe(true)
    expect(kept).toBe('~/Dev/Users/rob/Dev/')
  })

  it('keeps a fuzzy backend match the local filter would not make', () => {
    // searchFiles matches subsequences; monaco's own filter is stricter
    expect(filterFor('@promptbox', '@src/renderer/src/components/PromptBox.tsx')).toBe(
      '@promptbox@src/renderer/src/components/PromptBox.tsx'
    )
  })

  it('is stable for a whole-line replacement, not just a path', () => {
    expect(filterFor('/npm de', '/npm dev')).toBe('/npm dev')
    expect(filterFor('/npm serve', '/npm dev')).toBe('/npm serve/npm dev')
  })
})
