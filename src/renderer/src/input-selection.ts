/**
 * Shift-selection in Claude Code's own input, which has none. The caret is moved
 * with Claude Code's keys and the terminal cursor shows where it landed; the
 * selection is the cells between that and where it started. Deleting it is
 * backspacing until the caret is back at the start, checked step by step —
 * the screen can't tell a wrapped row from a newline, so counts are not trusted.
 * Rows count from the input's `❯` row: the input sits at the bottom of the
 * screen, so its rows move up and down as it grows and shrinks.
 */

export interface Cell {
  x: number
  /** row within the input, 0 = the `❯` row */
  y: number
}

/** The terminal, as the selection needs it. */
export interface InputScreen {
  cursor(): Cell
  /** text of an input row, trailing blanks trimmed */
  row(y: number): string
  send(data: string): void
  /** resolves once the cursor moved, or after a short wait */
  settled(): Promise<void>
}

export type SelectMove = 'left' | 'right' | 'wordLeft' | 'wordRight' | 'lineStart' | 'lineEnd'

export const MOVE_KEYS: Record<SelectMove, string> = {
  left: '\x1b[D',
  right: '\x1b[C',
  wordLeft: '\x1bb',
  wordRight: '\x1bf',
  lineStart: '\x01',
  lineEnd: '\x05'
}

const BACKSPACE = '\x7f'
/** "❯ " / continuation indent before the input's text */
const TEXT_COL = 2
const MAX_STEPS = 200

/** The selecting move for a ⇧ key combo, or null. ⇧↑ ⇧↓ stay Claude Code's (effort). */
export function selectMove(e: {
  key: string
  shiftKey: boolean
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
}): SelectMove | null {
  if (!e.shiftKey || e.ctrlKey || (e.metaKey && e.altKey)) return null
  if (e.key === 'ArrowLeft') return e.metaKey ? 'lineStart' : e.altKey ? 'wordLeft' : 'left'
  if (e.key === 'ArrowRight') return e.metaKey ? 'lineEnd' : e.altKey ? 'wordRight' : 'right'
  return null
}

const INPUT_ROWS = 30

/** The buffer row of the `❯` row holding the caret at buffer row `y`, with
 *  only indented continuation rows between; null when the caret is elsewhere. */
export function promptRow(row: (y: number) => string, y: number): number | null {
  for (let r = y; r >= Math.max(0, y - INPUT_ROWS); r--) {
    const text = row(r)
    if (text.startsWith('❯')) return r
    if (text && !text.startsWith('  ')) return null
  }
  return null
}

export const before = (a: Cell, b: Cell): boolean => a.y < b.y || (a.y === b.y && a.x < b.x)
const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y

/** Start and end of the selection, in reading order. */
export function span(anchor: Cell, caret: Cell): [Cell, Cell] {
  return before(caret, anchor) ? [caret, anchor] : [anchor, caret]
}

/** Cells from start to end as one run, for `term.select`. */
export function cellRun(anchor: Cell, caret: Cell, cols: number): Cell & { length: number } {
  const [s, e] = span(anchor, caret)
  return { x: s.x, y: s.y, length: (e.y - s.y) * cols + e.x - s.x }
}

/** The selected text: each row's text, without the input's indent. */
export function selectedText(screen: Pick<InputScreen, 'row'>, anchor: Cell, caret: Cell): string {
  const [s, e] = span(anchor, caret)
  const rows: string[] = []
  for (let y = s.y; y <= e.y; y++) {
    const text = screen.row(y)
    const from = y === s.y ? s.x : TEXT_COL
    rows.push(y === e.y ? text.slice(from, e.x) : text.slice(from))
  }
  return rows.join('\n')
}

/** Walk the caret to `target`. False when it would not get there. */
export async function moveCaret(screen: InputScreen, target: Cell): Promise<boolean> {
  for (let i = 0; i < MAX_STEPS; i++) {
    const c = screen.cursor()
    if (same(c, target)) return true
    if (c.y === target.y) {
      const n = target.x - c.x
      screen.send((n > 0 ? MOVE_KEYS.right : MOVE_KEYS.left).repeat(Math.abs(n)))
    } else if (c.y < target.y) {
      screen.send(MOVE_KEYS.right.repeat(Math.max(0, screen.row(c.y).length - c.x) + 1))
    } else {
      screen.send(MOVE_KEYS.left.repeat(Math.max(0, c.x - TEXT_COL) + 1))
    }
    await screen.settled()
    if (same(screen.cursor(), c)) return false // at an edge: no further to go
  }
  return false
}

/** Delete from `start` to `end` (reading order): caret to the end, then
 *  backspace back to the start. */
export async function deleteSpan(screen: InputScreen, start: Cell, end: Cell): Promise<boolean> {
  if (!(await moveCaret(screen, end))) return false
  for (let i = 0; i < MAX_STEPS; i++) {
    const c = screen.cursor()
    if (!before(start, c)) return true
    if (c.y === start.y) {
      screen.send(BACKSPACE.repeat(c.x - start.x))
    } else if (c.x > TEXT_COL) {
      screen.send(BACKSPACE.repeat(c.x - TEXT_COL))
    } else {
      // at a row's start: the start sitting at the end of the row above is the
      // same place when that row only wrapped — one more would eat a character
      if (c.y - 1 === start.y && start.x >= screen.row(start.y).length) return true
      screen.send(BACKSPACE)
    }
    await screen.settled()
    if (same(screen.cursor(), c)) return false
  }
  return false
}
