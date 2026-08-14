import { describe, expect, it } from 'vitest'
import type { ConvoHit } from '../../shared/types'
import { previewOf, roleLabel, segments, stepHit } from './convo-find'

const hit = (over: Partial<ConvoHit> = {}): ConvoHit => ({
  index: 0,
  role: 'claude',
  time: null,
  text: 'hello',
  clipped: false,
  matches: [],
  ...over
})

describe('segments', () => {
  it('splits a line into plain and matching runs, in order', () => {
    expect(segments('find the buffer, find it', [{ start: 9, end: 15 }])).toEqual([
      { text: 'find the ', hit: false },
      { text: 'buffer', hit: true },
      { text: ', find it', hit: false }
    ])
  })

  it('handles a match at the very start and at the very end', () => {
    expect(segments('ab', [{ start: 0, end: 1 }])).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: false }
    ])
    expect(segments('ab', [{ start: 1, end: 2 }])).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: true }
    ])
  })

  it('never drops or repeats text, whatever the matches say', () => {
    const text = 'aaaa'
    const overlapping = [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 3, end: 4 }
    ]
    expect(
      segments(text, overlapping)
        .map((s) => s.text)
        .join('')
    ).toBe(text)
  })

  it('is one plain run when nothing matched', () => {
    expect(segments('plain', [])).toEqual([{ text: 'plain', hit: false }])
  })
})

describe('previewOf', () => {
  it('flattens newlines so a row stays one line', () => {
    const preview = previewOf(
      hit({ text: 'first line\nsecond line', matches: [{ start: 11, end: 17 }] })
    )
    expect(preview.text).toBe('first line second line')
    expect(preview.text.slice(preview.matches[0].start, preview.matches[0].end)).toBe('second')
  })

  it('cuts around the match and marks what it dropped', () => {
    const long = 'x'.repeat(400) + 'needle' + 'y'.repeat(400)
    const preview = previewOf(hit({ text: long, matches: [{ start: 400, end: 406 }] }), 60)
    expect(preview.text.startsWith('…')).toBe(true)
    expect(preview.text.endsWith('…')).toBe(true)
    expect(preview.text.length).toBeLessThanOrEqual(62)
    expect(preview.text.slice(preview.matches[0].start, preview.matches[0].end)).toBe('needle')
  })

  it('keeps the offsets right when the window is trimmed', () => {
    const preview = previewOf(
      hit({ text: '   \n  padded needle here', matches: [{ start: 13, end: 19 }] })
    )
    expect(preview.text).toBe('padded needle here')
    expect(preview.text.slice(preview.matches[0].start, preview.matches[0].end)).toBe('needle')
  })

  it('says a clipped turn goes on, even when the window fits', () => {
    const preview = previewOf(hit({ text: 'a windowed turn', clipped: true, matches: [] }))
    expect(preview.text).toBe('…a windowed turn…')
  })

  it('shows the run-up when the match sits at the end of a long turn', () => {
    const long = 'z'.repeat(300) + 'needle'
    const preview = previewOf(hit({ text: long, matches: [{ start: 300, end: 306 }] }), 60)
    expect(preview.text.endsWith('needle')).toBe(true)
    expect(preview.text.slice(preview.matches[0].start, preview.matches[0].end)).toBe('needle')
  })

  it('drops matches that fell outside the window', () => {
    const long = 'needle' + 'x'.repeat(400) + 'needle'
    const preview = previewOf(
      hit({
        text: long,
        matches: [
          { start: 0, end: 6 },
          { start: 406, end: 412 }
        ]
      }),
      60
    )
    expect(preview.matches).toHaveLength(1)
    expect(preview.text.slice(preview.matches[0].start, preview.matches[0].end)).toBe('needle')
  })
})

describe('roleLabel', () => {
  it('names the tool for tool turns, and the speaker otherwise', () => {
    expect(roleLabel({ role: 'tool', tool: 'Bash' })).toBe('Bash')
    expect(roleLabel({ role: 'tool' })).toBe('tool')
    expect(roleLabel({ role: 'user' })).toBe('you')
    expect(roleLabel({ role: 'claude' })).toBe('claude')
    expect(roleLabel({ role: 'thinking' })).toBe('thinking')
  })
})

describe('stepHit', () => {
  it('wraps around in both directions', () => {
    expect(stepHit(3, 0, 1)).toBe(1)
    expect(stepHit(3, 2, 1)).toBe(0)
    expect(stepHit(3, 0, -1)).toBe(2)
    expect(stepHit(3, 2, -1)).toBe(1)
  })

  it('lands on the first hit when nothing is selected yet', () => {
    expect(stepHit(3, -1, 1)).toBe(0)
    expect(stepHit(3, -1, -1)).toBe(0)
  })

  it('selects nothing when there are no hits', () => {
    expect(stepHit(0, -1, 1)).toBe(-1)
    expect(stepHit(0, 4, -1)).toBe(-1)
  })
})
