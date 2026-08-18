import { describe, expect, it } from 'vitest'
import { aggregateActivity, mergeBlocks, workSpans } from './activity-log'

interface Beat {
  ts: number
  session: string
  cwd: string
  branch: string
}

const WORK = '/Users/rob/Dev/MendriX_Dev/mendrix-mobile-next'
const HOBBY = '/Users/rob/Dev/synthor'
const NOW = new Date(2026, 7, 12, 23, 0, 0).getTime()
const at = (h: number, min = 0): number => new Date(2026, 7, 12, h, min, 0).getTime() / 1000

/** Heartbeats every `stepMin` covering `minutes` from `fromHM`, one session. */
function beats(
  session: string,
  cwd: string,
  branch: string,
  fromHM: [number, number],
  minutes: number,
  stepMin = 2
): Beat[] {
  const start = at(fromHM[0], fromHM[1])
  const out: Beat[] = []
  for (let t = 0; t <= minutes; t += stepMin) out.push({ ts: start + t * 60, session, cwd, branch })
  return out
}

const report = (
  events: Beat[],
  coverage?: Parameters<typeof aggregateActivity>[1]['coverage']
): ReturnType<typeof aggregateActivity> =>
  aggregateActivity(events, { rangeDays: 7, coverage, nowMs: NOW })

describe('mergeBlocks', () => {
  it('bridges gaps up to the tolerance and drops what ended before `from`', () => {
    expect(
      mergeBlocks(
        [
          { start: 0, end: 100 },
          { start: 200, end: 300 },
          { start: 1000, end: 1100 }
        ],
        150
      )
    ).toEqual([
      { start: 0, end: 300 },
      { start: 1000, end: 1100 }
    ])
    expect(mergeBlocks([{ start: 0, end: 100 }], 0, 50)).toEqual([{ start: 50, end: 100 }])
    expect(mergeBlocks([{ start: 0, end: 100 }], 0, 100)).toEqual([])
  })
})

describe('aggregateActivity — workday length', () => {
  it('counts parallel sessions once', () => {
    const day = report([
      ...beats('a', WORK, 'bugfix/MTX-1-x', [9, 0], 120),
      ...beats('b', WORK, 'feature/MTX-2-y', [9, 0], 120)
    ]).days[0]
    // two tickets worked at the same time: 4h of effort, 2h of workday
    expect(day.totalHours).toBe(4)
    expect(day.workHours).toBe(2)
    expect(day.suggestedHours).toBe(2)
  })

  it('leaves personal projects out of the workday', () => {
    const day = report([
      ...beats('a', WORK, 'bugfix/MTX-1-x', [9, 0], 120),
      ...beats('b', HOBBY, 'feat/synth', [20, 0], 180)
    ]).days[0]
    expect(day.workHours).toBe(2)
    expect(day.suggestedHours).toBe(2)
    // hobby time is still tracked and shown, it just isn't part of the workday
    expect(day.totalHours).toBe(5)
    expect(day.lastTs).toBe(at(11))
  })

  it('bridges a short break but splits on a long one', () => {
    expect(
      report([
        ...beats('a', WORK, 'bugfix/MTX-1-x', [9, 0], 120),
        ...beats('b', WORK, 'bugfix/MTX-1-x', [11, 20], 100)
      ]).days[0].workHours
    ).toBe(4) // 09:00→13:00 whole, the 20-min break included
    expect(
      report([
        ...beats('a', WORK, 'bugfix/MTX-1-x', [9, 0], 120),
        ...beats('b', WORK, 'bugfix/MTX-1-x', [12, 15], 120),
        ...beats('c', WORK, 'bugfix/MTX-1-x', [20, 0], 30)
      ]).days[0].workHours
    ).toBe(4.5) // lunch and the evening off are not worked
  })

  it('bills an idle gap only up to the cap, but still bridges it', () => {
    // beats 30 min apart: 5 min of engaged time each, one 09:00→09:35 block
    const day = report(beats('a', WORK, 'bugfix/MTX-1-x', [9, 0], 60, 30)).days[0]
    expect(day.totalHours).toBe(0.17)
    expect(day.workHours).toBe(0.58)
  })
})

describe('aggregateActivity — settled windows', () => {
  const events = [
    ...beats('a', WORK, 'bugfix/MTX-1-x', [9, 0], 240),
    ...beats('b', WORK, 'bugfix/MTX-1-x', [20, 0], 60)
  ]

  it('offers the whole day while nothing is settled', () => {
    const day = report(events).days[0]
    expect(day.settledToTs).toBe(0)
    expect(day.suggestedHours).toBe(5)
    expect(day.buckets[0].unsettledHours).toBe(day.buckets[0].hours)
  })

  it('offers only the work done after the settled window', () => {
    const day = report(events, { '2026-08-12': { fromTs: at(9), toTs: at(13), hours: 8 } }).days[0]
    expect(day.settledHours).toBe(8)
    expect(day.suggestedHours).toBe(1) // just the 20:00-21:00 stretch
    expect(day.buckets[0].hours).toBe(5)
    expect(day.buckets[0].unsettledHours).toBe(1)
  })

  it('has nothing left when the settled window covers the day', () => {
    const day = report(events, { '2026-08-12': { fromTs: at(9), toTs: at(22), hours: 8 } }).days[0]
    expect(day.suggestedHours).toBe(0)
    expect(day.buckets[0].unsettledHours).toBe(0)
  })

  it('does not re-open a settled day for a few stray minutes', () => {
    const day = report(events, {
      '2026-08-12': { fromTs: at(9), toTs: at(20, 55), hours: 8 }
    }).days[0]
    expect(day.suggestedHours).toBe(0)
    expect(day.buckets[0].unsettledHours).toBe(0.08)
  })
})

describe('workSpans', () => {
  it('spans the first to the last work activity, personal projects aside', () => {
    const spans = workSpans([
      ...beats('a', HOBBY, 'feat/synth', [7, 0], 30),
      ...beats('b', WORK, 'bugfix/MTX-1-x', [9, 0], 60),
      ...beats('c', WORK, 'master', [17, 0], 30),
      ...beats('d', HOBBY, 'feat/synth', [22, 0], 30)
    ])
    expect(spans['2026-08-12']).toEqual({ firstTs: at(9), lastTs: at(17, 30) })
  })
})
