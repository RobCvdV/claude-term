import { describe, expect, it } from 'vitest'
import type { WorklogCoverage } from '../shared/types'
import { coverageByDate, nextWindow } from './worklog-coverage'

const rec = (date: string, fromTs: number, toTs: number, hours: number): WorklogCoverage => ({
  date,
  fromTs,
  toTs,
  hours,
  at: 0
})

const at = (h: number, min = 0): number => new Date(2026, 7, 12, h, min, 0).getTime() / 1000
const NOW_MS = new Date(2026, 7, 12, 22, 0, 0).getTime()

describe('coverageByDate', () => {
  it('folds a day’s records into one window and sums the hours', () => {
    const by = coverageByDate([
      rec('2026-08-12', at(9), at(18), 8),
      rec('2026-08-12', at(18), at(21), 1.5),
      rec('2026-08-11', at(10), at(17), 8)
    ])
    expect(by['2026-08-12']).toEqual({ fromTs: at(9), toTs: at(21), hours: 9.5 })
    expect(by['2026-08-11']).toEqual({ fromTs: at(10), toTs: at(17), hours: 8 })
  })

  it('skips records without a window', () => {
    expect(coverageByDate([rec('2026-08-12', 0, 0, 8)])).toEqual({})
  })
})

describe('nextWindow', () => {
  const span = { firstTs: at(9), lastTs: at(18) }

  it('covers the whole tracked day the first time', () => {
    expect(nextWindow('2026-08-12', span, undefined, at(20))).toEqual({
      fromTs: at(9),
      toTs: at(18)
    })
  })

  it('picks up where the previous booking left off', () => {
    const prior = { fromTs: at(9), toTs: at(16), hours: 8 }
    expect(nextWindow('2026-08-12', span, prior, at(20))).toEqual({
      fromTs: at(16),
      toTs: at(18)
    })
  })

  it('never goes backwards when nothing new was tracked', () => {
    const prior = { fromTs: at(9), toTs: at(18), hours: 8 }
    expect(nextWindow('2026-08-12', span, prior, at(20))).toEqual({
      fromTs: at(18),
      toTs: at(18)
    })
  })

  it('settles a day with no tracked work up to now', () => {
    const now = Math.floor(NOW_MS / 1000)
    expect(nextWindow('2026-08-12', undefined, undefined, now)).toEqual({
      fromTs: now,
      toTs: now
    })
    // a past day is settled to its end, so nothing can trail after it
    expect(nextWindow('2026-08-10', undefined, undefined, now).toTs).toBe(
      Math.floor(new Date(2026, 7, 10, 23, 59, 59).getTime() / 1000)
    )
  })
})
