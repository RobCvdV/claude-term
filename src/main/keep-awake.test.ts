import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAwake } from './keep-awake'

describe('KeepAwake', () => {
  let started = 0
  let stopped: number[] = []
  const power = { start: () => ++started, stop: (id: number) => stopped.push(id) }

  beforeEach(() => {
    vi.useFakeTimers()
    started = 0
    stopped = []
  })
  afterEach(() => vi.useRealTimers())

  it('holds while working and lets go after the grace period', () => {
    const k = new KeepAwake(power, 1000)
    k.update(true)
    k.update(true)
    expect(started).toBe(1)
    k.update(false)
    vi.advanceTimersByTime(999)
    expect(k.holding).toBe(true)
    vi.advanceTimersByTime(1)
    expect(k.holding).toBe(false)
    expect(stopped).toEqual([1])
  })

  it('new work within the grace keeps the same hold', () => {
    const k = new KeepAwake(power, 1000)
    k.update(true)
    k.update(false)
    vi.advanceTimersByTime(500)
    k.update(true)
    k.update(false)
    vi.advanceTimersByTime(900)
    expect(k.holding).toBe(true)
    expect(started).toBe(1)
    vi.advanceTimersByTime(100)
    expect(stopped).toEqual([1])
  })

  it('never holds without work, and release ends it at once', () => {
    const k = new KeepAwake(power, 1000)
    k.update(false)
    expect(started).toBe(0)
    k.update(true)
    k.release()
    expect(stopped).toEqual([1])
    vi.advanceTimersByTime(5000)
    expect(stopped).toEqual([1])
  })
})
