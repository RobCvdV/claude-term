import { describe, expect, it } from 'vitest'
import { dispatchHours, dispatchRemaining, snapToStep } from './worklog'

describe('dispatchHours', () => {
  it('splits proportionally in 30-min units, summing exactly to the total', () => {
    const r = dispatchHours(8, [
      { id: 'a', actual: 6 },
      { id: 'b', actual: 2 }
    ])
    expect(r).toEqual([
      { id: 'a', hours: 6 },
      { id: 'b', hours: 2 }
    ])
  })

  it('hands leftover blocks to the largest remainders', () => {
    const r = dispatchHours(1, [
      { id: 'a', actual: 1 },
      { id: 'b', actual: 1 },
      { id: 'c', actual: 1.1 }
    ])
    expect(r.reduce((s, x) => s + x.hours, 0)).toBe(1)
    expect(r.find((x) => x.id === 'c')!.hours).toBe(0.5)
  })

  it('returns zeros when nothing tracked or no total', () => {
    expect(dispatchHours(0, [{ id: 'a', actual: 2 }])).toEqual([{ id: 'a', hours: 0 }])
    expect(dispatchHours(4, [{ id: 'a', actual: 0 }])).toEqual([{ id: 'a', hours: 0 }])
  })
})

describe('dispatchRemaining', () => {
  it('books the full split when nothing is booked yet', () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 6, booked: 0 },
      { id: 'b', actual: 2, booked: 0 }
    ])
    expect(r).toEqual([
      { id: 'a', target: 6, toBook: 6 },
      { id: 'b', target: 2, toBook: 2 }
    ])
  })

  it('books only the hours left on a half-logged day', () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 6, booked: 4 },
      { id: 'b', actual: 2, booked: 0 }
    ])
    expect(r).toEqual([
      { id: 'a', target: 6, toBook: 2 },
      { id: 'b', target: 2, toBook: 2 }
    ])
  })

  it('never books negative on an over-booked ticket', () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 6, booked: 7 },
      { id: 'b', actual: 2, booked: 0 }
    ])
    expect(r.find((x) => x.id === 'a')!.toBook).toBe(0)
    expect(r.find((x) => x.id === 'b')!.toBook).toBe(2)
  })

  it('fully booked day has nothing left', () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 6, booked: 6 },
      { id: 'b', actual: 2, booked: 2 }
    ])
    expect(r.every((x) => x.toBook === 0)).toBe(true)
  })

  it('a pinned row takes its value; the rest re-split what remains of the day', () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 4, booked: 0, pinned: 1 },
      { id: 'b', actual: 2, booked: 0 },
      { id: 'c', actual: 2, booked: 0 }
    ])
    expect(r.find((x) => x.id === 'a')!.toBook).toBe(1)
    // 7h pool split evenly over b and c
    expect(r.find((x) => x.id === 'b')!.toBook).toBe(3.5)
    expect(r.find((x) => x.id === 'c')!.toBook).toBe(3.5)
  })

  it("a pinned row's booked hours count toward its claim on the day", () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 4, booked: 2, pinned: 2 },
      { id: 'b', actual: 4, booked: 0 }
    ])
    // a claims 2 booked + 2 pinned = 4h of the day; b gets the other 4h
    expect(r.find((x) => x.id === 'b')!.toBook).toBe(4)
  })

  it('pins are snapped to 30-min steps and clamp at 0', () => {
    const r = dispatchRemaining(8, [
      { id: 'a', actual: 4, booked: 0, pinned: 1.2 },
      { id: 'b', actual: 4, booked: 0, pinned: -3 }
    ])
    expect(r.find((x) => x.id === 'a')!.toBook).toBe(1)
    expect(r.find((x) => x.id === 'b')!.toBook).toBe(0)
  })

  it('all rows pinned leaves nothing to redistribute', () => {
    const r = dispatchRemaining(4, [
      { id: 'a', actual: 1, booked: 0, pinned: 0.5 },
      { id: 'b', actual: 1, booked: 0, pinned: 8 }
    ])
    expect(r.map((x) => x.toBook)).toEqual([0.5, 8])
  })
})

describe('snapToStep', () => {
  it('rounds to the nearest 30 min and clamps at 0', () => {
    expect(snapToStep(1.2)).toBe(1)
    expect(snapToStep(1.3)).toBe(1.5)
    expect(snapToStep(-2)).toBe(0)
  })
})
