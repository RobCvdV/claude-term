import { describe, expect, it } from 'vitest'
import { dropIndex, moveItem, shiftFor } from './tab-reorder'

describe('moveItem', () => {
  it('moves an item to the right', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item to the left', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns the same array when nothing moves', () => {
    const list = ['a', 'b']
    expect(moveItem(list, 1, 1)).toBe(list)
  })

  it('ignores out-of-range indices', () => {
    const list = ['a', 'b']
    expect(moveItem(list, 5, 0)).toBe(list)
    expect(moveItem(list, 0, 5)).toBe(list)
  })
})

describe('dropIndex', () => {
  // four 100px-wide tabs
  const centers = [50, 150, 250, 350]

  it('stays put until the dragged centre passes a neighbour', () => {
    expect(dropIndex(centers, 0, 140)).toBe(0)
    expect(dropIndex(centers, 0, 160)).toBe(1)
  })

  it('walks right past several neighbours', () => {
    expect(dropIndex(centers, 0, 360)).toBe(3)
  })

  it('walks left past several neighbours', () => {
    expect(dropIndex(centers, 3, 40)).toBe(0)
  })

  it('clamps at both ends', () => {
    expect(dropIndex(centers, 3, 9999)).toBe(3)
    expect(dropIndex(centers, 0, -9999)).toBe(0)
  })
})

describe('shiftFor', () => {
  it('slides the tabs the dragged one passed on its way right', () => {
    expect(shiftFor(0, 0, 2, 100)).toBe(0) // the dragged tab itself
    expect(shiftFor(1, 0, 2, 100)).toBe(-100)
    expect(shiftFor(2, 0, 2, 100)).toBe(-100)
    expect(shiftFor(3, 0, 2, 100)).toBe(0)
  })

  it('slides the tabs the dragged one passed on its way left', () => {
    expect(shiftFor(0, 3, 1, 100)).toBe(0)
    expect(shiftFor(1, 3, 1, 100)).toBe(100)
    expect(shiftFor(2, 3, 1, 100)).toBe(100)
    expect(shiftFor(3, 3, 1, 100)).toBe(0)
  })

  it('leaves everything alone when the drag has not crossed a slot', () => {
    expect([0, 1, 2].map((i) => shiftFor(i, 1, 1, 100))).toEqual([0, 0, 0])
  })
})
