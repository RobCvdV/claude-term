import type { ActivityState, TabStatus } from '../../shared/types'

// Every "where should focus go now?" decision in the renderer lives here, as
// pure functions over a tab's state. App and PromptBox only do the moving.
//
// The rule behind all of them: the prompt box owns focus, and the terminal
// borrows it only while the TUI is showing something the user must drive with
// the keyboard. Terminal focus is therefore always temporary — see focus-loan.

/** Where keyboard focus should go. 'none' = leave it where it is. */
export type FocusTarget = 'box' | 'terminal' | 'none'

/** The modifier state of a keypress, as both xterm and Monaco report it. */
export interface ToggleKey {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  key: string
  code: string
}

/**
 * ⌥Tab — the one focus move the user makes by hand, from either side. The rules
 * above are automatic and occasionally leave focus where it isn't wanted; this
 * is the manual override, and it reads the same on both sides of the boundary.
 *
 * `code` is checked as well as `key` because Option can rewrite `key` on some
 * layouts, while `code` stays the physical key. Every other Tab combination is
 * left alone: plain Tab runs Claude's suggestion and ⇧Tab cycles the permission
 * mode, so ⌥⇧Tab must not be mistaken for this.
 */
export function isFocusToggle(e: ToggleKey): boolean {
  return (
    e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'Tab' || e.code === 'Tab')
  )
}

/** The subset of a tab's status the focus rules read. */
export interface FocusState {
  claudeActive: boolean
  activity: ActivityState
}

export function focusStateOf(status: TabStatus | null | undefined): FocusState | null {
  return status ? { claudeActive: status.claudeActive, activity: status.activity } : null
}

/**
 * Where focus belongs for a tab in this state: an active claude session with no
 * pending dialog → the prompt box; a dialog the user must drive, or a plain
 * terminal (no session) → the terminal. Used on tab switch, on prompt-box
 * mount, and after a modal overlay closes.
 */
export function focusForTab(state: FocusState | null): 'box' | 'terminal' {
  return state?.claudeActive && state.activity !== 'needs-attention' ? 'box' : 'terminal'
}

/**
 * The focus move implied by a tab's status changing. `prev` is null the first
 * time we see the tab.
 *
 * - a claude session appeared → the box; it ended → the terminal
 * - the turn finished, or a dialog was answered → the box
 * - a dialog appeared → the terminal (belt-and-braces next to the attention
 *   hook, which is what normally gets there first)
 */
export function focusOnStatusChange(
  prev: FocusState | null,
  next: FocusState,
  isActiveTab: boolean
): FocusTarget {
  if (!isActiveTab) return 'none'
  if (prev?.claudeActive !== next.claudeActive) return next.claudeActive ? 'box' : 'terminal'
  if (!next.claudeActive || prev.activity === next.activity) return 'none'
  const turnFinished = next.activity === 'idle' && prev.activity !== 'idle'
  const dialogAnswered = prev.activity === 'needs-attention' && next.activity !== 'needs-attention'
  if (turnFinished || dialogAnswered) return 'box'
  return next.activity === 'needs-attention' ? 'terminal' : 'none'
}

/** What the prompt box should do with focus right after submitting `text`. */
export type SubmitFocus =
  /** keep (or take back) focus — nothing in the terminal needs driving */
  | 'box'
  /** hand focus over for the menu this command opens, and watch for its return */
  | 'lend-terminal'
  /** stay in the box, but watch in case the command opens a menu later */
  | 'watch-terminal'

/**
 * A slash command usually opens a TUI menu, so the terminal wants focus — but
 * only if the command runs *now*. Submitted mid-turn it is merely queued, and
 * handing focus over stranded it on the terminal for the rest of the turn.
 * Anything else (a plain prompt, a submit with no live session) keeps the box
 * focused, which also brings focus back after a click on the Send button.
 */
export function focusAfterSubmit(text: string, state: FocusState | null): SubmitFocus {
  if (!state?.claudeActive || !text.startsWith('/')) return 'box'
  return state.activity === 'idle' ? 'lend-terminal' : 'watch-terminal'
}

/**
 * Esc in the terminal dismisses a client-side overlay (/usage, /config, …) and
 * should hand focus back to the box. We can't gate on 'idle': those commands
 * fire UserPromptSubmit (→busy) but run no model turn, so no Stop ever arrives
 * and the tab stays 'busy'. Only a real dialog keeps focus in the terminal.
 */
export function focusOnTerminalEscape(state: FocusState | null): FocusTarget {
  return state?.claudeActive && state.activity !== 'needs-attention' ? 'box' : 'none'
}
