// A focus "loan": the terminal only ever borrows focus from the prompt box, and
// always gives it back. Whether a TUI dialog actually opened can't be known up
// front (a slash command may print nothing, or be queued behind a running
// turn), so we poll what the terminal rendered and act on what we see.
//
// The step function is pure so every path is unit-testable; runFocusLoan is the
// thin timer around it.

/**
 * 'handover' — focus was just given to the terminal for a menu we expect to
 *   open. Take it back if none shows up, or once the one that did is gone.
 * 'watch' — the box keeps focus (the command was queued mid-turn), but a menu
 *   may still open later; lend focus if one does.
 */
export type LoanMode = 'handover' | 'watch'

export interface LoanProbe {
  /** the prompt box currently has keyboard focus */
  boxFocused: boolean
  /** the terminal is showing a dialog the user must drive */
  dialogOpen: boolean
}

export type LoanAction = 'none' | 'focus-box' | 'focus-terminal'

export interface LoanState {
  mode: LoanMode
  ticks: number
  /** a dialog has been seen at least once — now wait for it to close */
  opened: boolean
  done: boolean
}

/** Poll interval, ms. */
export const TICK_MS = 200
/** How long a handover waits for its menu to appear before reclaiming focus. */
export const OPEN_TICKS = 5
/** How long a queued command is watched for a menu before giving up (~60s). */
export const WATCH_TICKS = 300

export function startLoan(mode: LoanMode): LoanState {
  return { mode, ticks: 0, opened: false, done: false }
}

const finished = (state: LoanState): LoanState => ({ ...state, done: true })

/** Advance a loan by one poll. */
export function stepLoan(
  state: LoanState,
  probe: LoanProbe
): { state: LoanState; action: LoanAction } {
  if (state.done) return { state, action: 'none' }
  const ticks = state.ticks + 1

  if (state.mode === 'watch') {
    // focus left the box on its own — whatever moved it now owns the decision
    if (!probe.boxFocused) return { state: finished(state), action: 'none' }
    if (probe.dialogOpen) {
      return {
        state: { mode: 'handover', ticks: 0, opened: true, done: false },
        action: 'focus-terminal'
      }
    }
    if (ticks >= WATCH_TICKS) return { state: finished(state), action: 'none' }
    return { state: { ...state, ticks }, action: 'none' }
  }

  // handover: the terminal has focus right now
  if (probe.boxFocused) return { state: finished(state), action: 'none' } // user came back
  if (!state.opened) {
    if (probe.dialogOpen) return { state: { ...state, ticks, opened: true }, action: 'none' }
    // nothing opened in time — the command printed no menu, take focus back
    if (ticks >= OPEN_TICKS) return { state: finished(state), action: 'focus-box' }
    return { state: { ...state, ticks }, action: 'none' }
  }
  // the dialog is gone — it was answered or dismissed
  if (!probe.dialogOpen) return { state: finished(state), action: 'focus-box' }
  return { state: { ...state, ticks }, action: 'none' }
}

export interface FocusLoanDeps {
  probe: () => LoanProbe
  focusBox: () => void
  focusTerminal: () => void
}

/** Run a loan until it settles. Returns a cancel function. */
export function runFocusLoan(mode: LoanMode, deps: FocusLoanDeps): () => void {
  let state = startLoan(mode)
  const timer = setInterval(() => {
    const next = stepLoan(state, deps.probe())
    state = next.state
    if (next.action === 'focus-box') deps.focusBox()
    else if (next.action === 'focus-terminal') deps.focusTerminal()
    if (state.done) clearInterval(timer)
  }, TICK_MS)
  return () => clearInterval(timer)
}
