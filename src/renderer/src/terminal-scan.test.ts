import { describe, expect, it } from 'vitest'
import {
  agentsOverviewInRows,
  dialogOpenInRows,
  hasDialogFooter,
  hasPromptInputRow,
  isDimCell,
  suggestionInLines,
  type ScanCell,
  type ScanLine
} from './terminal-scan'

// Bottom rows as xterm renders them (bottom-most first), trimmed the way
// translateToString(true) leaves them.

const IDLE_PROMPT = [
  '  ? for shortcuts',
  '╰──────────────────────────────────────────────╯',
  '│ >                                            │',
  '╭──────────────────────────────────────────────╮',
  ''
]

const BUSY_PROMPT = [
  '  esc to interrupt',
  '╰──────────────────────────────────────────────╯',
  '│ >                                            │',
  '╭──────────────────────────────────────────────╮',
  '✻ Thinking… (12s · ↑ 1.2k tokens)'
]

const PERMISSION_DIALOG = [
  '',
  '   2. No, tell Claude what to do differently',
  '   1. Yes',
  ' ❯ Do you want to proceed?',
  '│ Bash(npm test)',
  '╭─ Permission required ────────────────────────╮'
]

const MODEL_PICKER = [
  '  ↑/↓ to select · Enter to confirm · Esc to cancel',
  '    Opus 5',
  '  ❯ Sonnet 5',
  '  Select a model',
  ''
]

const AGENTS_OVERVIEW = [
  '  enter to return · space to reply · ctrl+x to delete',
  '──────────────────────────────────────────────',
  '> ',
  '──────────────────────────────────────────────',
  '  2 agents running'
]

describe('hasPromptInputRow', () => {
  it('finds the input line in the idle and busy prompt views', () => {
    expect(hasPromptInputRow(IDLE_PROMPT)).toBe(true)
    expect(hasPromptInputRow(BUSY_PROMPT)).toBe(true)
  })

  it('accepts the alternate prompt glyphs', () => {
    expect(hasPromptInputRow(['│ ❯ hello'])).toBe(true)
    expect(hasPromptInputRow(['│ › hello'])).toBe(true)
    expect(hasPromptInputRow(['> '])).toBe(true)
  })

  it('does not see one when a full-screen dialog replaced it', () => {
    expect(hasPromptInputRow(MODEL_PICKER)).toBe(false)
    expect(hasPromptInputRow(PERMISSION_DIALOG)).toBe(false)
  })

  it('ignores a ">" buried in ordinary output', () => {
    expect(hasPromptInputRow(['   diff --git a/x b/x', '  foo => bar', 'a > b'])).toBe(false)
  })

  it('does not mistake a picker row for the input line', () => {
    // "❯" is both the prompt marker and the selection cursor
    expect(hasPromptInputRow(['  ❯ Sonnet 5'])).toBe(false)
    expect(hasPromptInputRow([' ❯ Do you want to proceed?'])).toBe(false)
  })
})

describe('hasDialogFooter', () => {
  it('recognises the pickers that own the keyboard', () => {
    expect(hasDialogFooter(MODEL_PICKER)).toBe(true)
    expect(hasDialogFooter(AGENTS_OVERVIEW)).toBe(true)
    expect(hasDialogFooter(PERMISSION_DIALOG)).toBe(true)
  })

  it('does not fire on the normal prompt footers', () => {
    expect(hasDialogFooter(IDLE_PROMPT)).toBe(false)
    expect(hasDialogFooter(BUSY_PROMPT)).toBe(false)
  })
})

describe('dialogOpenInRows', () => {
  it('is false while the ordinary prompt is showing', () => {
    expect(dialogOpenInRows(IDLE_PROMPT)).toBe(false)
    expect(dialogOpenInRows(BUSY_PROMPT)).toBe(false)
  })

  it('is true for a permission prompt', () => {
    expect(dialogOpenInRows(PERMISSION_DIALOG)).toBe(true)
  })

  it('is true for a picker', () => {
    expect(dialogOpenInRows(MODEL_PICKER)).toBe(true)
  })

  it('is true for the agents overview, which keeps its own input row', () => {
    expect(hasPromptInputRow(AGENTS_OVERVIEW)).toBe(true) // the input row is there…
    expect(dialogOpenInRows(AGENTS_OVERVIEW)).toBe(true) // …but the footer gives it away
  })

  it('is false without evidence — an empty buffer is not a dialog', () => {
    // erring this way costs an early hand-back to the box; erring the other way
    // would pin focus to the terminal for good
    expect(dialogOpenInRows([])).toBe(false)
    expect(dialogOpenInRows(['', '', ''])).toBe(false)
  })

  it('is false for a wall of ordinary output', () => {
    expect(dialogOpenInRows(['  → wrote src/x.ts', '  Read 120 lines', '> quoted line'])).toBe(
      false
    )
  })
})

describe('agentsOverviewInRows', () => {
  it('matches only the overview', () => {
    expect(agentsOverviewInRows(AGENTS_OVERVIEW)).toBe(true)
    expect(agentsOverviewInRows(MODEL_PICKER)).toBe(false)
    expect(agentsOverviewInRows(IDLE_PROMPT)).toBe(false)
  })
})

// How a cell is coloured, the way xterm reports it after parsing the TUI's SGR codes.
type Style = 'normal' | 'dim' | { palette: number } | { rgb: number }

function cell(ch: string, style: Style = 'normal'): ScanCell {
  return {
    getChars: () => ch,
    isDim: () => (style === 'dim' ? 1 : 0),
    isFgPalette: () => typeof style === 'object' && 'palette' in style,
    isFgRGB: () => typeof style === 'object' && 'rgb' in style,
    getFgColor: () =>
      typeof style === 'object' ? ('palette' in style ? style.palette : style.rgb) : 0
  }
}

const COLS = 60

/** A terminal row from styled pieces, padded with blank cells to COLS. */
function row(...pieces: [string, Style?][]): ScanLine {
  const cells: ScanCell[] = []
  for (const [text, style] of pieces) for (const ch of text) cells.push(cell(ch, style))
  while (cells.length < COLS) cells.push(cell(''))
  return { getCell: (x) => cells[x] }
}

const blank = row()
const rule = row(['─'.repeat(COLS)])

/** The input line under the box's top rule, as bottom-most-first rows. */
function input(...pieces: [string, Style?][]): ScanLine[] {
  return [rule, row(...pieces), rule]
}

describe('suggestionInLines', () => {
  it('returns the dim text after the marker', () => {
    expect(suggestionInLines(input(['❯ '], ['run the tests', 'dim']), COLS)).toBe('run the tests')
  })

  it('reads the input line above the agents list of a running side job', () => {
    // Claude Code 2.1.312 with a background agent: the selected agent row
    // below the input carries the same ❯ marker, in normal colour
    const lines = [
      row(['❯ ○ general-purpose  Checking unit test runner configuration']),
      row(['● main']),
      blank,
      row(['Enter to view · x to stop']),
      blank,
      ...input(['❯ '], ['check sentry for the mschaafsma devicelog', 'dim'])
    ]
    expect(suggestionInLines(lines, COLS)).toBe('check sentry for the mschaafsma devicelog')
  })

  it('treats the dim "Try …" placeholder like a suggestion', () => {
    const lines = input(['❯ '], ['Try "edit App.tsx to..."', 'dim'])
    expect(suggestionInLines(lines, COLS)).toBe('Try "edit App.tsx to..."')
  })

  it('returns null for an empty input line', () => {
    expect(suggestionInLines(input(['❯ ']), COLS)).toBeNull()
  })

  it('returns null once the user has typed', () => {
    expect(suggestionInLines(input(['❯ '], ['fix the build']), COLS)).toBeNull()
  })

  it('returns null when typed text is followed by a dim remainder', () => {
    expect(suggestionInLines(input(['❯ '], ['run'], [' the tests', 'dim']), COLS)).toBeNull()
  })

  // one normally coloured char anywhere (a highlighted path, a cursor cell)
  // makes the whole line count as typed
  it('returns null when a single char of the suggestion is not dim', () => {
    const lines = input(['❯ '], ['open ', 'dim'], ['README.md'], [' next', 'dim'])
    expect(suggestionInLines(lines, COLS)).toBeNull()
  })

  it('accepts the gray colours a TUI uses instead of the dim attribute', () => {
    for (const style of [{ palette: 8 }, { palette: 240 }, { rgb: 0x808080 }] as Style[]) {
      expect(suggestionInLines(input(['❯ '], ['commit this', style]), COLS)).toBe('commit this')
    }
  })

  it('does not take near-white text for a suggestion', () => {
    expect(suggestionInLines(input(['❯ '], ['commit this', { rgb: 0xe0e0e0 }]), COLS)).toBeNull()
  })

  it('reads inside a bordered input box and stops at its right border', () => {
    const lines = [
      row(['╰' + '─'.repeat(COLS - 2) + '╯']),
      row(['│ ❯ '], ['commit this', 'dim'], ['   │'], [' outside', 'dim']),
      row(['╭' + '─'.repeat(COLS - 2) + '╮'])
    ]
    expect(suggestionInLines(lines, COLS)).toBe('commit this')
  })

  it('keeps inner spaces and trims the ends', () => {
    expect(suggestionInLines(input(['❯ '], ['  add   a test  ', 'dim']), COLS)).toBe('add   a test')
  })

  it('uses the live input line, not an earlier prompt in the transcript', () => {
    const lines = [
      ...input(['❯ '], ['run the tests', 'dim']),
      row(['● ok']),
      row(['❯ '], ['Reply with only the word ok.'])
    ]
    expect(suggestionInLines(lines, COLS)).toBe('run the tests')
  })

  it('stops at the input line even when it has no suggestion', () => {
    const lines = [...input(['❯ ']), ...input(['❯ '], ['an older suggestion', 'dim'])]
    expect(suggestionInLines(lines, COLS)).toBeNull()
  })

  it('ignores a marker row with no rule above it', () => {
    expect(suggestionInLines([row(['❯ '], ['run the tests', 'dim']), blank], COLS)).toBeNull()
  })

  it('ignores a marker that is not near the start of the row', () => {
    expect(suggestionInLines(input(['          ❯ '], ['run the tests', 'dim']), COLS)).toBeNull()
  })

  it('skips missing lines', () => {
    expect(suggestionInLines([undefined, ...input(['> '], ['go', 'dim'])], COLS)).toBe('go')
  })

  it('returns null with no marker at all', () => {
    expect(suggestionInLines([blank, row(['robcoenen@pcvm claude-term % '])], COLS)).toBeNull()
  })
})

describe('isDimCell', () => {
  it('is true for the dim attribute', () => {
    expect(isDimCell(cell('a', 'dim'))).toBe(true)
  })

  it('is false for the default colour', () => {
    expect(isDimCell(cell('a'))).toBe(false)
  })

  it('takes palette 8 and the 235–245 grays, nothing around them', () => {
    const dim = (n: number): boolean => isDimCell(cell('a', { palette: n }))
    expect([8, 235, 240, 245].map(dim)).toEqual([true, true, true, true])
    expect([7, 15, 234, 246, 255].map(dim)).toEqual([false, false, false, false, false])
  })

  it('takes RGB colours whose brightest channel is below 150, but not black', () => {
    const dim = (rgb: number): boolean => isDimCell(cell('a', { rgb }))
    expect(dim(0x959595)).toBe(true) // 149
    expect(dim(0x969696)).toBe(false) // 150
    expect(dim(0x2060a0)).toBe(false) // blue channel 160
    expect(dim(0x000000)).toBe(false)
  })
})
