import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPEN_TICKS,
  runFocusLoan,
  startLoan,
  stepLoan,
  TICK_MS,
  WATCH_TICKS,
  type LoanAction,
  type LoanProbe,
  type LoanState
} from './focus-loan'

const probe = (boxFocused: boolean, dialogOpen: boolean): LoanProbe => ({
  boxFocused,
  dialogOpen
})

/** Feed a loan a scripted sequence of polls; collect the actions it asks for. */
function drive(state: LoanState, probes: LoanProbe[]): { state: LoanState; actions: LoanAction[] } {
  const actions: LoanAction[] = []
  for (const p of probes) {
    const next = stepLoan(state, p)
    state = next.state
    if (next.action !== 'none') actions.push(next.action)
  }
  return { state, actions }
}

describe('stepLoan — handover (the terminal has focus)', () => {
  it('takes focus back when no dialog ever opens', () => {
    const { state, actions } = drive(
      startLoan('handover'),
      Array(OPEN_TICKS).fill(probe(false, false))
    )
    expect(actions).toEqual(['focus-box'])
    expect(state.done).toBe(true)
  })

  it('waits the full grace period before reclaiming', () => {
    const { state, actions } = drive(
      startLoan('handover'),
      Array(OPEN_TICKS - 1).fill(probe(false, false))
    )
    expect(actions).toEqual([])
    expect(state.done).toBe(false)
  })

  it('holds focus in the terminal for as long as the dialog is up', () => {
    const { state, actions } = drive(startLoan('handover'), [
      probe(false, false),
      probe(false, true),
      ...Array(50).fill(probe(false, true))
    ])
    expect(actions).toEqual([])
    expect(state.done).toBe(false)
    expect(state.opened).toBe(true)
  })

  it('takes focus back as soon as the dialog closes', () => {
    const { state, actions } = drive(startLoan('handover'), [
      probe(false, true),
      probe(false, true),
      probe(false, false)
    ])
    expect(actions).toEqual(['focus-box'])
    expect(state.done).toBe(true)
  })

  it('stops without touching focus when the user goes back to the box', () => {
    const { state, actions } = drive(startLoan('handover'), [probe(false, true), probe(true, true)])
    expect(actions).toEqual([])
    expect(state.done).toBe(true)
  })

  it('is inert once finished', () => {
    const done = drive(startLoan('handover'), Array(OPEN_TICKS).fill(probe(false, false))).state
    expect(stepLoan(done, probe(false, true))).toEqual({ state: done, action: 'none' })
  })
})

describe('stepLoan — watch (a queued command, the box has focus)', () => {
  it('does nothing while no dialog appears', () => {
    const { state, actions } = drive(startLoan('watch'), Array(20).fill(probe(true, false)))
    expect(actions).toEqual([])
    expect(state.done).toBe(false)
  })

  it('hands focus over when the queued command finally opens its menu', () => {
    const { state, actions } = drive(startLoan('watch'), [
      probe(true, false),
      probe(true, false),
      probe(true, true)
    ])
    expect(actions).toEqual(['focus-terminal'])
    expect(state.mode).toBe('handover')
    expect(state.opened).toBe(true)
    expect(state.done).toBe(false)
  })

  it('gives the focus back once that menu closes', () => {
    const { state, actions } = drive(startLoan('watch'), [
      probe(true, true), // menu opened → terminal takes focus
      probe(false, true),
      probe(false, false) // menu gone → box takes it back
    ])
    expect(actions).toEqual(['focus-terminal', 'focus-box'])
    expect(state.done).toBe(true)
  })

  it('gives up after the watch window', () => {
    const { state, actions } = drive(
      startLoan('watch'),
      Array(WATCH_TICKS).fill(probe(true, false))
    )
    expect(actions).toEqual([])
    expect(state.done).toBe(true)
  })

  it('bows out when focus leaves the box on its own', () => {
    const { state, actions } = drive(startLoan('watch'), [probe(false, false)])
    expect(actions).toEqual([])
    expect(state.done).toBe(true)
  })
})

describe('runFocusLoan', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reclaims focus for the box when a slash command opens nothing', () => {
    const focusBox = vi.fn()
    const focusTerminal = vi.fn()
    runFocusLoan('handover', {
      probe: () => probe(false, false),
      focusBox,
      focusTerminal
    })
    vi.advanceTimersByTime(TICK_MS * OPEN_TICKS)
    expect(focusBox).toHaveBeenCalledTimes(1)
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('stops polling once settled', () => {
    const focusBox = vi.fn()
    runFocusLoan('handover', {
      probe: () => probe(false, false),
      focusBox,
      focusTerminal: vi.fn()
    })
    vi.advanceTimersByTime(TICK_MS * OPEN_TICKS * 10)
    expect(focusBox).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rides a dialog out: hold, then hand focus back when it closes', () => {
    const focusBox = vi.fn()
    let dialogOpen = true
    runFocusLoan('handover', {
      probe: () => probe(false, dialogOpen),
      focusBox,
      focusTerminal: vi.fn()
    })
    vi.advanceTimersByTime(TICK_MS * 100)
    expect(focusBox).not.toHaveBeenCalled()
    dialogOpen = false
    vi.advanceTimersByTime(TICK_MS)
    expect(focusBox).toHaveBeenCalledTimes(1)
  })

  it('cancel stops the loan before it can move focus', () => {
    const focusBox = vi.fn()
    const cancel = runFocusLoan('handover', {
      probe: () => probe(false, false),
      focusBox,
      focusTerminal: vi.fn()
    })
    vi.advanceTimersByTime(TICK_MS * (OPEN_TICKS - 1))
    cancel()
    vi.advanceTimersByTime(TICK_MS * 100)
    expect(focusBox).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
