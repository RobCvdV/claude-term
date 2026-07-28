import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityState } from '../../shared/types'
import { runFocusLoan, OPEN_TICKS, TICK_MS, WATCH_TICKS } from './focus-loan'
import {
  focusAfterSubmit,
  focusForTab,
  focusOnStatusChange,
  focusOnTerminalEscape,
  type FocusState,
  type FocusTarget
} from './focus-policy'

/**
 * A stand-in for App + PromptBox: the same wiring, minus React, Monaco and
 * xterm. Lets the scenarios below replay a whole session the way it actually
 * unfolds — status updates arriving from the hooks, the user submitting, the
 * TUI opening and closing dialogs — and assert where focus ends up.
 */
class Session {
  focused: 'box' | 'terminal' = 'box'
  /** what the TUI is showing (what terminalDialogOpen would scrape) */
  dialogOpen = false
  private state: FocusState
  private prev: FocusState | null = null
  private cancelLoan: (() => void) | null = null

  constructor(activity: ActivityState = 'idle', claudeActive = true) {
    this.state = { claudeActive, activity }
    this.prev = this.state
    this.focused = focusForTab(this.state)
  }

  private apply(target: FocusTarget): void {
    if (target !== 'none') this.focused = target
  }

  private lend(mode: 'handover' | 'watch'): void {
    this.cancelLoan?.()
    this.cancelLoan = runFocusLoan(mode, {
      probe: () => ({ boxFocused: this.focused === 'box', dialogOpen: this.dialogOpen }),
      focusBox: () => (this.focused = 'box'),
      focusTerminal: () => (this.focused = 'terminal')
    })
  }

  /** a hook moved the tab's activity (App's status effect) */
  activity(next: ActivityState): this {
    const state = { ...this.state, activity: next }
    this.state = state
    this.apply(focusOnStatusChange(this.prev, state, true))
    this.prev = state
    return this
  }

  /** the user submits from the prompt box (PromptBox.send) */
  submit(text: string): this {
    switch (focusAfterSubmit(text, this.state)) {
      case 'lend-terminal':
        this.focused = 'terminal'
        this.lend('handover')
        break
      case 'watch-terminal':
        this.focused = 'box'
        this.lend('watch')
        break
      default:
        this.cancelLoan?.()
        this.cancelLoan = null
        this.focused = 'box'
    }
    return this
  }

  /** the claude session starts or ends (SessionStart / SessionEnd hooks) */
  claude(active: boolean): this {
    const state = { claudeActive: active, activity: 'idle' as ActivityState }
    this.state = state
    this.apply(focusOnStatusChange(this.prev, state, true))
    this.prev = state
    return this
  }

  /** the user presses Esc in the terminal (App's escape handler) */
  escape(): this {
    this.apply(focusOnTerminalEscape(this.state))
    return this
  }

  /** the TUI opens or closes a dialog, and time passes */
  render(dialogOpen: boolean, ticks = 1): this {
    this.dialogOpen = dialogOpen
    vi.advanceTimersByTime(TICK_MS * ticks)
    return this
  }

  /** time passes with nothing on screen changing */
  wait(ticks: number): this {
    vi.advanceTimersByTime(TICK_MS * ticks)
    return this
  }
}

describe('focus scenarios', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a plain prompt sent mid-turn keeps the box focused and starts nothing', () => {
    const s = new Session('busy')
    s.submit('also fix the tests')
    expect(s.focused).toBe('box')
    expect(vi.getTimerCount()).toBe(0)
    s.wait(50)
    expect(s.focused).toBe('box')
  })

  it('the box keeps focus while a queued slash command waits its turn', () => {
    // the reported bug: focus went to the terminal on submit and stayed there
    // for the rest of the running turn, because no menu had opened to leave
    const s = new Session('busy')
    s.submit('/model')
    expect(s.focused).toBe('box')
    s.wait(20) // the running turn grinds on
    expect(s.focused).toBe('box')
  })

  it('hands focus over when the queued command finally opens its menu, then back', () => {
    const s = new Session('busy')
    s.submit('/model')
    s.activity('idle') // the turn that was running finishes
    expect(s.focused).toBe('box')
    s.render(true) // the queued /model picker opens
    expect(s.focused).toBe('terminal')
    s.render(false) // a model is picked
    expect(s.focused).toBe('box')
  })

  it('stops watching a queued command that never opens anything', () => {
    const s = new Session('busy')
    s.submit('/compact')
    s.wait(WATCH_TICKS)
    expect(s.focused).toBe('box')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a slash command run while idle drives its menu in the terminal', () => {
    const s = new Session('idle')
    s.submit('/model')
    expect(s.focused).toBe('terminal')
    s.render(true, 2)
    expect(s.focused).toBe('terminal')
    s.render(false)
    expect(s.focused).toBe('box')
  })

  it('takes focus back from a slash command that opens no menu at all', () => {
    const s = new Session('idle')
    s.submit('/cost')
    expect(s.focused).toBe('terminal')
    s.wait(OPEN_TICKS)
    expect(s.focused).toBe('box')
  })

  it('recovers from a client-side overlay that never ends its turn', () => {
    // /usage fires UserPromptSubmit (→busy) but runs no model turn, so no Stop
    // ever arrives — the loan, not the activity state, is what frees the focus
    const s = new Session('idle')
    s.submit('/usage')
    s.activity('busy')
    s.render(true, 3)
    expect(s.focused).toBe('terminal')
    s.render(false) // the user dismisses the overlay
    expect(s.focused).toBe('box')
    expect(s.activity('busy').focused).toBe('box') // still no Stop, still fine
  })

  it('Esc out of an overlay still works when the loan missed it', () => {
    const s = new Session('idle')
    s.submit('/usage').activity('busy')
    s.render(false, OPEN_TICKS) // never detected → focus already came back
    s.focused = 'terminal' // …the user clicked into the terminal anyway
    s.escape()
    expect(s.focused).toBe('box')
  })

  it('a permission prompt takes focus, and answering it gives focus back', () => {
    const s = new Session('idle')
    s.submit('go')
    s.activity('busy')
    expect(s.focused).toBe('box')
    s.activity('needs-attention')
    expect(s.focused).toBe('terminal')
    s.activity('busy') // PostToolUse: the approved tool is running
    expect(s.focused).toBe('box')
  })

  it('a permission prompt during a lent-out slash command is not fought over', () => {
    const s = new Session('idle')
    s.submit('/agents')
    s.render(true, 2)
    s.activity('needs-attention')
    expect(s.focused).toBe('terminal')
    s.render(false) // dialog gone
    s.activity('idle') // turn over
    expect(s.focused).toBe('box')
  })

  it('follows the session in and out of the tab', () => {
    const s = new Session('idle', false)
    expect(s.focused).toBe('terminal') // plain terminal
    s.claude(true)
    expect(s.focused).toBe('box')
    s.claude(false)
    expect(s.focused).toBe('terminal')
  })

  it('leaves no timers behind once everything settles', () => {
    const s = new Session('busy')
    s.submit('/model')
    s.activity('idle')
    s.render(true, 2)
    s.render(false)
    expect(s.focused).toBe('box')
    expect(vi.getTimerCount()).toBe(0)
  })
})
