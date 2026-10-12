import { describe, expect, it } from 'vitest'
import type { PersistedTab } from '../shared/types'
import {
  nextWindowId,
  sessionFileOf,
  spatialOrder,
  stepTabId,
  usableBounds,
  windowAtTabBar,
  windowsOf
} from './window-order'

const at = (
  id: number,
  x: number,
  y: number
): { id: number; bounds: { x: number; y: number; width: number; height: number } } => ({
  id,
  bounds: { x, y, width: 800, height: 600 }
})

describe('spatialOrder', () => {
  it('orders left to right, then top to bottom', () => {
    const order = spatialOrder([at(1, 900, 0), at(2, 0, 500), at(3, 0, 0)]).map((w) => w.id)
    expect(order).toEqual([3, 2, 1])
  })
})

describe('nextWindowId', () => {
  it('wraps, and starts at the first from outside the list', () => {
    expect(nextWindowId([3, 2, 1], 2)).toBe(1)
    expect(nextWindowId([3, 2, 1], 1)).toBe(3)
    expect(nextWindowId([3, 2, 1], 9)).toBe(3)
    expect(nextWindowId([], 1)).toBeNull()
  })
})

describe('stepTabId', () => {
  it('steps both ways with wrap-around', () => {
    expect(stepTabId(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(stepTabId(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(stepTabId(['a', 'b'], null, 1)).toBe('a')
    expect(stepTabId([], 'a', 1)).toBeNull()
  })
})

describe('windowAtTabBar', () => {
  it('only hits the strip at the top of a window', () => {
    const wins = [at(1, 0, 0), at(2, 1000, 0)]
    expect(windowAtTabBar(wins, 1100, 20)).toBe(2)
    expect(windowAtTabBar(wins, 1100, 300)).toBeNull()
    expect(windowAtTabBar(wins, 850, 20)).toBeNull()
  })
})

describe('usableBounds', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }
  it('keeps bounds that are on a display', () => {
    const b = { x: 100, y: 100, width: 800, height: 600 }
    expect(usableBounds(b, [display])).toBe(b)
  })
  it('drops bounds on a display that is gone, or too small', () => {
    expect(usableBounds({ x: 3000, y: 0, width: 800, height: 600 }, [display])).toBeUndefined()
    expect(usableBounds({ x: 0, y: 0, width: 100, height: 600 }, [display])).toBeUndefined()
    expect(usableBounds(undefined, [display])).toBeUndefined()
  })
})

describe('session file', () => {
  const tab = (cwd: string): PersistedTab => ({
    cwd,
    title: cwd,
    manualTitle: false,
    sessionId: null,
    claudeActive: false
  })

  it('reads a single-window file as one window', () => {
    expect(windowsOf({ tabs: [tab('/a')], activeIndex: 0 })).toEqual([
      { tabs: [tab('/a')], activeIndex: 0 }
    ])
    expect(windowsOf(null)).toEqual([])
  })

  it('mirrors the first window at the top level for older versions', () => {
    const w1 = { tabs: [tab('/a')], activeIndex: 0 }
    const w2 = { tabs: [tab('/b'), tab('/c')], activeIndex: 1 }
    const file = sessionFileOf([w1, w2])
    expect(file.tabs).toEqual(w1.tabs)
    expect(windowsOf(file)).toEqual([w1, w2])
  })
})
