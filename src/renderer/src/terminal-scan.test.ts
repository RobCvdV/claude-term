import { describe, expect, it } from 'vitest'
import {
  agentsOverviewInRows,
  dialogOpenInRows,
  hasDialogFooter,
  hasPromptInputRow
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
