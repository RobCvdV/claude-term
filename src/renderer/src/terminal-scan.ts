// Pure predicates over what Claude Code has rendered in a tab's terminal.
// Kept free of xterm so they can be unit-tested against plain rows of text;
// term-registry supplies the rows (bottom-most first).

/** Prompt-marker glyphs Claude Code uses at the start of its input line. */
export const PROMPT_MARKERS = ['>', '❯', '›'] as const

// The TUI's input row: the marker behind the input box's left border, or a bare
// marker on an otherwise empty line. Anchored tightly because "❯" doubles as a
// dialog's selection cursor and ">" shows up in ordinary output (diffs, quotes).
const PROMPT_ROW_RE = /^\s*(?:[│┃]\s{0,3}[>❯›](?:\s|$)|[>❯›]\s*$)/

// A dialog's selection cursor: "❯ Yes", "❯ Sonnet 5" — the marker with a choice
// beside it and no input-box border in front of it.
const SELECTION_ROW_RE = /^\s*[❯›]\s+\S/

// Footer hints TUI dialogs print while they own the keyboard.
const DIALOG_FOOTER_RE =
  /(esc to cancel|enter to confirm|enter to select|enter to return|space to reply|ctrl\+x to delete|↑\/↓ to (?:select|navigate))/i

/** Is Claude Code's normal input line rendered in these rows? */
export function hasPromptInputRow(rows: string[]): boolean {
  return rows.some((row) => PROMPT_ROW_RE.test(row))
}

/** Does any row carry a dialog's keyboard-hint footer? */
export function hasDialogFooter(rows: string[]): boolean {
  return rows.some((row) => SELECTION_ROW_RE.test(row) || DIALOG_FOOTER_RE.test(row))
}

/**
 * Is the terminal showing something the user must drive with the keyboard —
 * a permission prompt, a picker, the agents overview?
 *
 * Deliberately built on *positive* evidence (a dialog footer, or a selection
 * cursor with the normal input line gone) rather than "the input line is
 * missing". Getting this wrong in the false-positive direction would pin focus
 * to the terminal forever, which is the bug this whole mechanism exists to fix;
 * a false negative only costs an early hand-back the user can undo with Esc.
 */
export function dialogOpenInRows(rows: string[]): boolean {
  if (rows.some((row) => DIALOG_FOOTER_RE.test(row))) return true
  return rows.some((row) => SELECTION_ROW_RE.test(row)) && !hasPromptInputRow(rows)
}

// The agents overview's footer hint — the one part of that view that is
// reliably distinguishable from the normal prompt view (both render an input
// row between plain "────" separators, so the input row itself can't be used).
const AGENTS_FOOTER_RE = /enter to return|space to reply|ctrl\+x to delete/i

/** Is Claude Code's agents overview (opened with ← on an empty prompt) showing? */
export function agentsOverviewInRows(rows: string[]): boolean {
  return rows.some((row) => AGENTS_FOOTER_RE.test(row))
}

/** The parts of an xterm buffer cell the suggestion scraper reads. */
export interface ScanCell {
  getChars(): string
  isDim(): number
  isFgPalette(): boolean
  isFgRGB(): boolean
  getFgColor(): number
}

/** The part of an xterm buffer line the suggestion scraper reads. */
export interface ScanLine {
  getCell(x: number): ScanCell | undefined
}

/**
 * A cell belongs to Claude Code's grayed-out suggestion (not typed text) when
 * it's rendered dim/faint, or in a low-brightness gray — the styles a TUI uses
 * for placeholder/ghost text. Kept as one predicate so it's the single knob to
 * tune if a Claude Code version changes how it dims the suggestion.
 */
export function isDimCell(cell: ScanCell): boolean {
  if (cell.isDim()) return true
  if (cell.isFgPalette()) {
    const c = cell.getFgColor()
    // 8 = bright black (typical "dim gray"); 235-245 = dark grays in the 256 cube
    return c === 8 || (c >= 235 && c <= 245)
  }
  if (cell.isFgRGB()) {
    const rgb = cell.getFgColor()
    const max = Math.max((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff)
    return max > 0 && max < 150 // darkish, not near-white — a gray/ghost tone
  }
  return false
}

const PROMPT_MARKER_SET = new Set<string>(PROMPT_MARKERS)

interface SuggestionScan {
  /** full text after the marker (spaces preserved), trimmed at the ends */
  raw: string
  /** a non-space, dim (suggestion-colored) char was seen after the marker */
  hasDim: boolean
  /** a non-space, normally-colored (user-typed) char was seen after the marker */
  hasTyped: boolean
}

// Walk the input line from just after the prompt marker to the box's right
// border, keeping the full text and flagging whether the printed (non-space)
// chars are dim (a suggestion) or normally colored (text the user has typed).
function scanRow(line: ScanLine, cols: number): SuggestionScan | null {
  // find the prompt marker, allowing a leading box border "│" and padding
  let markerCol = -1
  for (let x = 0; x < Math.min(cols, 8); x++) {
    if (PROMPT_MARKER_SET.has(line.getCell(x)?.getChars() ?? '')) {
      markerCol = x
      break
    }
  }
  if (markerCol < 0) return null
  let raw = ''
  let hasDim = false
  let hasTyped = false
  for (let x = markerCol + 1; x < cols; x++) {
    const c = line.getCell(x)
    if (!c) continue
    const ch = c.getChars()
    if (ch === '│' || ch === '┃') break // right border of the input box
    raw += ch
    if (ch.trim()) {
      if (isDimCell(c)) hasDim = true
      else hasTyped = true
    }
  }
  return { raw: raw.trim(), hasDim, hasTyped }
}

// The input box's top edge: a plain rule, or the corner of a bordered box.
const RULE_START = new Set(['─', '━', '╭', '┌'])

function firstChar(line: ScanLine | undefined, cols: number): string {
  for (let x = 0; line && x < cols; x++) {
    const ch = line.getCell(x)?.getChars() ?? ''
    if (ch.trim()) return ch
  }
  return ''
}

/**
 * Claude Code's suggested next prompt (its grayed ghost text) in the input
 * line, or null when there is none or the user has typed something. `lines`
 * are the bottom rows, bottom-most first; the input line is the bottom-most
 * marker row directly under the box's top rule.
 */
export function suggestionInLines(lines: (ScanLine | undefined)[], cols: number): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // the agents list under the input marks its selected row with ❯ too
    if (!RULE_START.has(firstChar(lines[i + 1], cols))) continue
    const scan = scanRow(line, cols)
    if (!scan) continue
    if (scan.hasTyped) return null
    return scan.hasDim && scan.raw ? scan.raw : null
  }
  return null
}
