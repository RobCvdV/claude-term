import { describe, expect, it } from 'vitest'
import type { ActivityState, TabStatus } from '../../shared/types'
import {
  focusAfterSubmit,
  focusForTab,
  focusOnStatusChange,
  focusOnTerminalEscape,
  focusStateOf,
  type FocusState
} from './focus-policy'

const state = (claudeActive: boolean, activity: ActivityState): FocusState => ({
  claudeActive,
  activity
})

/** Every activity a live claude session can be in. */
const ACTIVITIES: ActivityState[] = [
  'starting',
  'busy',
  'idle',
  'needs-attention',
  'ended',
  'exited'
]

describe('focusStateOf', () => {
  it('is null without a status', () => {
    expect(focusStateOf(null)).toBeNull()
    expect(focusStateOf(undefined)).toBeNull()
  })

  it('keeps only the focus-relevant fields', () => {
    const status = { claudeActive: true, activity: 'busy', cwd: '/x', tabId: 't' } as TabStatus
    expect(focusStateOf(status)).toEqual({ claudeActive: true, activity: 'busy' })
  })
})

describe('focusForTab', () => {
  it('sends focus to the terminal when there is no session yet', () => {
    expect(focusForTab(null)).toBe('terminal')
  })

  it('sends focus to the terminal for a plain terminal tab', () => {
    for (const activity of ACTIVITIES) {
      expect(focusForTab(state(false, activity))).toBe('terminal')
    }
  })

  it('sends focus to the box for a live session with no pending dialog', () => {
    for (const activity of ACTIVITIES.filter((a) => a !== 'needs-attention')) {
      expect(focusForTab(state(true, activity))).toBe('box')
    }
  })

  it('leaves a waiting dialog with the terminal', () => {
    expect(focusForTab(state(true, 'needs-attention'))).toBe('terminal')
  })
})

describe('focusOnStatusChange', () => {
  it('never moves focus on a background tab', () => {
    expect(focusOnStatusChange(state(true, 'busy'), state(true, 'idle'), false)).toBe('none')
    expect(focusOnStatusChange(null, state(true, 'idle'), false)).toBe('none')
  })

  it('focuses the box when a claude session appears', () => {
    expect(focusOnStatusChange(state(false, 'idle'), state(true, 'idle'), true)).toBe('box')
  })

  it('focuses the terminal when the session ends', () => {
    expect(focusOnStatusChange(state(true, 'idle'), state(false, 'idle'), true)).toBe('terminal')
  })

  it('routes the first status of a tab by whether claude is live', () => {
    expect(focusOnStatusChange(null, state(false, 'idle'), true)).toBe('terminal')
    expect(focusOnStatusChange(null, state(true, 'idle'), true)).toBe('box')
  })

  it('focuses the box when the turn finishes', () => {
    expect(focusOnStatusChange(state(true, 'busy'), state(true, 'idle'), true)).toBe('box')
    expect(focusOnStatusChange(state(true, 'starting'), state(true, 'idle'), true)).toBe('box')
  })

  it('focuses the box the instant a dialog is answered', () => {
    // PostToolUse (the approved tool running) is the first signal back
    expect(focusOnStatusChange(state(true, 'needs-attention'), state(true, 'busy'), true)).toBe(
      'box'
    )
    // and a dialog answered at the very end of a turn goes straight to idle
    expect(focusOnStatusChange(state(true, 'needs-attention'), state(true, 'idle'), true)).toBe(
      'box'
    )
  })

  it('hands focus to the terminal when a dialog appears', () => {
    expect(focusOnStatusChange(state(true, 'busy'), state(true, 'needs-attention'), true)).toBe(
      'terminal'
    )
  })

  it('does not move focus while a turn is merely running', () => {
    expect(focusOnStatusChange(state(true, 'idle'), state(true, 'busy'), true)).toBe('none')
    expect(focusOnStatusChange(state(true, 'busy'), state(true, 'busy'), true)).toBe('none')
  })

  it('does not move focus for activity changes on a dead session', () => {
    expect(focusOnStatusChange(state(false, 'busy'), state(false, 'idle'), true)).toBe('none')
  })
})

describe('focusAfterSubmit', () => {
  it('keeps focus in the box for a plain prompt', () => {
    for (const activity of ACTIVITIES) {
      expect(focusAfterSubmit('do the thing', state(true, activity))).toBe('box')
    }
  })

  it('lends focus to the terminal for a slash command that runs now', () => {
    expect(focusAfterSubmit('/model', state(true, 'idle'))).toBe('lend-terminal')
  })

  it('keeps focus in the box for a slash command queued mid-turn', () => {
    // this is the bug: the prompt is queued, no menu opens, and handing focus
    // to the terminal stranded it there for the rest of the turn
    expect(focusAfterSubmit('/model', state(true, 'busy'))).toBe('watch-terminal')
    expect(focusAfterSubmit('/compact', state(true, 'starting'))).toBe('watch-terminal')
  })

  it('does not lend focus while a dialog is already waiting', () => {
    expect(focusAfterSubmit('/model', state(true, 'needs-attention'))).toBe('watch-terminal')
  })

  it('keeps focus in the box when no session is live', () => {
    expect(focusAfterSubmit('/model', state(false, 'idle'))).toBe('box')
    expect(focusAfterSubmit('/model', null)).toBe('box')
  })
})

describe('focusOnTerminalEscape', () => {
  it('takes focus back to the box after a client-side overlay closes', () => {
    // /usage and friends never leave 'busy' (no model turn → no Stop hook)
    expect(focusOnTerminalEscape(state(true, 'busy'))).toBe('box')
    expect(focusOnTerminalEscape(state(true, 'idle'))).toBe('box')
  })

  it('leaves focus in the terminal while a real dialog is waiting', () => {
    expect(focusOnTerminalEscape(state(true, 'needs-attention'))).toBe('none')
  })

  it('leaves a plain terminal alone', () => {
    expect(focusOnTerminalEscape(state(false, 'idle'))).toBe('none')
    expect(focusOnTerminalEscape(null)).toBe('none')
  })
})
