import { describe, expect, it } from 'vitest'
import type { BookedWorklog } from './types'
import {
  bookedKey,
  dayBookedState,
  defaultDayChecked,
  sumBookedByDate,
  sumBookedByKey
} from './worklog-booked'

const w = (date: string, issueKey: string, hours: number): BookedWorklog => ({
  date,
  issueKey,
  hours,
  worklogId: 'x'
})

describe('sumBookedByKey / sumBookedByDate', () => {
  const booked = [
    w('2026-08-06', 'MTX-1', 2),
    w('2026-08-06', 'MTX-1', 1.5),
    w('2026-08-06', 'MTX-2', 1),
    w('2026-08-05', 'MTX-1', 4)
  ]

  it('sums multiple worklogs on the same date+issue', () => {
    const byKey = sumBookedByKey(booked)
    expect(byKey[bookedKey('2026-08-06', 'MTX-1')]).toBe(3.5)
    expect(byKey[bookedKey('2026-08-06', 'MTX-2')]).toBe(1)
    expect(byKey[bookedKey('2026-08-05', 'MTX-1')]).toBe(4)
  })

  it('sums per day', () => {
    expect(sumBookedByDate(booked)).toEqual({ '2026-08-06': 4.5, '2026-08-05': 4 })
  })
})

describe('dayBookedState', () => {
  it('none when the day has ticket work but nothing booked', () => {
    expect(dayBookedState(4, 0)).toBe('none')
  })
  it('partial when booked less than tracked', () => {
    expect(dayBookedState(4, 2)).toBe('partial')
  })
  it('full when booked covers tracked (with tolerance)', () => {
    expect(dayBookedState(4, 4)).toBe('full')
    expect(dayBookedState(3.99, 4)).toBe('full')
    expect(dayBookedState(4.02, 4)).toBe('full')
  })
  it('full when there is no ticket work at all', () => {
    expect(dayBookedState(0, 0)).toBe('full')
  })
  it('judges a settled day on its unsettled tail, not on the hours booked', () => {
    // 13.5h tracked, booked as 8h — that day is done
    expect(dayBookedState(13.5, 8, { unsettledHours: 0 })).toBe('full')
    expect(dayBookedState(13.5, 8, { unsettledHours: 1.5 })).toBe('partial')
  })
})

describe('defaultDayChecked', () => {
  it('checked only while some row still has hours to book', () => {
    expect(defaultDayChecked([{ toBook: 0 }, { toBook: 0.5 }])).toBe(true)
    expect(defaultDayChecked([{ toBook: 0 }, { toBook: 0 }])).toBe(false)
    expect(defaultDayChecked([])).toBe(false)
  })

  it('leaves a day that already has worklogs for the user to tick', () => {
    const rows = [{ toBook: 2 }]
    expect(defaultDayChecked(rows, { bookedHours: 0, settled: false })).toBe(true)
    expect(defaultDayChecked(rows, { bookedHours: 4, settled: false })).toBe(false)
  })

  it('still offers the tail of a settled day', () => {
    expect(defaultDayChecked([{ toBook: 1.5 }], { bookedHours: 8, settled: true })).toBe(true)
    expect(defaultDayChecked([{ toBook: 0 }], { bookedHours: 8, settled: true })).toBe(false)
  })
})
