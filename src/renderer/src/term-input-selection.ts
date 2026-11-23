import type { Terminal } from '@xterm/xterm'
import {
  cellRun,
  deleteSpan,
  moveCaret,
  MOVE_KEYS,
  selectedText,
  promptRow,
  selectMove,
  span,
  type Cell,
  type InputScreen
} from './input-selection'

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Alt', 'Control', 'CapsLock'])
/** a redraw comes in a burst of writes; quiet this long means it is done */
const QUIET_MS = 25
const MAX_WAIT_MS = 300

export interface InputSelection {
  /** true: the key was handled here */
  key(e: KeyboardEvent): boolean
  /** true: the paste was handled here */
  paste(text: string): boolean
  /** true: typing is held while a selection is being deleted */
  holds(data: string): boolean
  clear(): void
}

/** ⇧-selection for one tab's Claude Code input. `usable`: a Claude Code tab
 *  without the prompt box, and no dialog holding the keys. */
export function inputSelection(
  term: Terminal,
  usable: () => boolean,
  send: (data: string) => void
): InputSelection {
  let anchor: Cell | null = null
  let busy = false
  const held: string[] = []

  const bufferRow = (y: number): string =>
    term.buffer.active.getLine(y)?.translateToString(true) ?? ''
  const caretRow = (): number => term.buffer.active.baseY + term.buffer.active.cursorY
  /** buffer row of the input's `❯` row, or null when the caret is not in it */
  const top = (): number | null => promptRow(bufferRow, caretRow())

  const screen: InputScreen = {
    cursor: () => ({ x: term.buffer.active.cursorX, y: caretRow() - (top() ?? caretRow()) }),
    row: (y) => bufferRow((top() ?? 0) + y),
    send,
    settled: () =>
      new Promise((resolve) => {
        let quiet = window.setTimeout(done, MAX_WAIT_MS / 2)
        const cap = window.setTimeout(done, MAX_WAIT_MS)
        const sub = term.onWriteParsed(() => {
          window.clearTimeout(quiet)
          quiet = window.setTimeout(done, QUIET_MS)
        })
        function done(): void {
          window.clearTimeout(quiet)
          window.clearTimeout(cap)
          sub.dispose()
          resolve()
        }
      })
  }

  const clear = (): void => {
    if (!anchor) return
    anchor = null
    term.clearSelection()
  }

  const show = (): void => {
    if (!anchor) return
    const caret = screen.cursor()
    const run = cellRun(anchor, caret, term.cols)
    const t = top()
    if (run.length && t !== null) term.select(run.x, t + run.y, run.length)
    else term.clearSelection()
  }

  /** Runs `job` with typing held back, then lets the held keys through. */
  const exclusive = (job: () => Promise<unknown>): void => {
    busy = true
    void job().finally(() => {
      busy = false
      const rest = held.splice(0).join('')
      if (rest) send(rest)
    })
  }

  const removeSelection = async (): Promise<void> => {
    if (!anchor) return
    const [start, end] = span(anchor, screen.cursor())
    clear()
    await deleteSpan(screen, start, end)
  }

  const copy = (): void => {
    if (anchor) void navigator.clipboard.writeText(selectedText(screen, anchor, screen.cursor()))
  }

  return {
    clear,
    holds: (data) => {
      if (busy) held.push(data)
      return busy
    },
    paste: (text) => {
      if (!anchor) return false
      exclusive(async () => {
        await removeSelection()
        term.paste(text)
      })
      return true
    },
    key: (e) => {
      if (e.type !== 'keydown' || e.isComposing || MODIFIER_KEYS.has(e.key)) return false
      const move = selectMove(e)
      if (move) {
        if (!usable() || top() === null) return false
        e.preventDefault()
        if (busy) return true
        anchor ??= screen.cursor()
        send(MOVE_KEYS[move])
        void screen.settled().then(show)
        return true
      }
      if (!anchor) return false
      if (busy) {
        e.preventDefault()
        return true
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey
      if (e.metaKey && !e.shiftKey && (e.key === 'c' || e.key === 'x')) {
        e.preventDefault()
        copy()
        if (e.key === 'x') exclusive(removeSelection)
        return true
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey) {
        e.preventDefault()
        exclusive(removeSelection)
        return true
      }
      if (plain && e.key.length === 1) {
        e.preventDefault()
        const ch = e.key
        exclusive(async () => {
          await removeSelection()
          send(ch)
        })
        return true
      }
      if (plain && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // like a text field: the caret goes to that end of the selection
        e.preventDefault()
        const [start, end] = span(anchor, screen.cursor())
        clear()
        exclusive(() => moveCaret(screen, e.key === 'ArrowLeft' ? start : end))
        return true
      }
      clear()
      return false
    }
  }
}
