import { describe, expect, it } from 'vitest'
import { usableFindings } from './findings'
import type { Finding } from './protocol'

const finding = (start: number, end: number, kind = 'Agreement', message = 'nope'): Finding => ({
  start,
  end,
  kind,
  message,
  replacements: []
})

describe('usableFindings', () => {
  it('keeps ordinary findings, sorted by position', () => {
    const kept = usableFindings([finding(20, 25), finding(5, 9)])
    expect(kept.map((f) => f.start)).toEqual([5, 20])
  })

  it('drops harper spelling lints — hunspell owns spelling', () => {
    const kept = usableFindings([finding(0, 4, 'Spelling'), finding(10, 14, 'Repetition')])
    expect(kept.map((f) => f.kind)).toEqual(['Repetition'])
  })

  it('drops empty and inverted spans', () => {
    expect(usableFindings([finding(7, 7), finding(9, 4)])).toEqual([])
  })

  it('keeps only the first of overlapping findings', () => {
    const kept = usableFindings([finding(0, 10), finding(4, 8), finding(9, 12)])
    expect(kept.map((f) => [f.start, f.end])).toEqual([[0, 10]])
  })

  it('prefers the longer span when two findings start together', () => {
    const kept = usableFindings([finding(3, 6), finding(3, 11)])
    expect(kept.map((f) => f.end)).toEqual([11])
  })

  it('keeps findings that merely touch end-to-start', () => {
    const kept = usableFindings([finding(0, 5), finding(5, 9)])
    expect(kept).toHaveLength(2)
  })
})
