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
