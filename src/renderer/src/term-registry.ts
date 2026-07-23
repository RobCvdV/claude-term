import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TabId } from '../../shared/types'

export interface TermEntry {
  term: Terminal
  fit: FitAddon
  /** Detached container div; TerminalPane parents it into the visible DOM. */
  containerEl: HTMLDivElement
}

/**
 * xterm instances live outside React so tab switches / re-renders never
 * recreate them: scrollback and session state survive for background tabs.
 */
const entries = new Map<TabId, TermEntry>()

let dataUnsub: (() => void) | null = null

/** App registers this to decide whether Esc in the terminal should hand focus
 *  back to the prompt box (e.g. after dismissing a /usage or /config overlay). */
let escapeHandler: (tabId: TabId) => void = () => {}
export function setTerminalEscapeHandler(fn: (tabId: TabId) => void): void {
  escapeHandler = fn
}

/** App registers this to update a tab's title from the shell's OSC title. */
let titleHandler: (tabId: TabId, title: string) => void = () => {}
export function setTerminalTitleHandler(fn: (tabId: TabId, title: string) => void): void {
  titleHandler = fn
}

function ensureRouting(): void {
  if (dataUnsub) return
  dataUnsub = window.claudeTerm.onPtyData((tabId, data) => {
    entries.get(tabId)?.term.write(data)
  })
}

export function createTerm(tabId: TabId): TermEntry {
  ensureRouting()
  const existing = entries.get(tabId)
  if (existing) return existing

  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, monospace',
    fontSize: 13,
    scrollback: 10_000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: {
      background: '#1a1b1e',
      foreground: '#d4d4d8',
      cursor: '#d4d4d8',
      selectionBackground: '#3b3f46'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  // Cmd/Ctrl-click URLs to open them in the default browser (iTerm2 style).
  // A plain click falls through to xterm's normal selection behaviour.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) window.claudeTerm.openExternal(uri)
    })
  )

  const containerEl = document.createElement('div')
  containerEl.className = 'term-container'
  term.open(containerEl)

  term.onData((data) => window.claudeTerm.ptyInput(tabId, data))
  term.onResize(({ cols, rows }) => window.claudeTerm.ptyResize(tabId, cols, rows))
  term.onTitleChange((title) => title && titleHandler(tabId, title))

  // Return true so xterm still sends the key to the PTY (Claude Code closes its
  // overlay); after that dispatches, App decides whether to refocus the box.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Escape') {
      window.setTimeout(() => escapeHandler(tabId), 0)
    }
    return true
  })

  const entry: TermEntry = { term, fit, containerEl }
  entries.set(tabId, entry)
  // exposed for scripted E2E testing (CDP) — harmless at runtime
  const registry = ((window as unknown as Record<string, unknown>).__terms ??= {}) as Record<
    TabId,
    Terminal
  >
  registry[tabId] = term
  return entry
}

export function getTerm(tabId: TabId): TermEntry | undefined {
  return entries.get(tabId)
}

// Prompt-marker glyphs Claude Code uses at the start of its input line.
const PROMPT_MARKERS = new Set(['>', '❯', '›'])

/**
 * A cell belongs to Claude Code's grayed-out suggestion (not typed text) when
 * it's rendered dim/faint, or in a low-brightness gray — the styles a TUI uses
 * for placeholder/ghost text. Kept as one predicate so it's the single knob to
 * tune if a Claude Code version changes how it dims the suggestion.
 */
function isDimCell(cell: import('@xterm/xterm').IBufferCell): boolean {
  if (cell.isDim()) return true
  // xterm exposes the resolved color; treat a dark-gray foreground as dim.
  if (cell.isFgPalette()) {
    const c = cell.getFgColor()
    // 8 = bright black (typical "dim gray"); 235-245 = dark grays in the 256 cube
    return c === 8 || (c >= 235 && c <= 245)
  }
  if (cell.isFgRGB()) {
    const rgb = cell.getFgColor()
    const r = (rgb >> 16) & 0xff
    const g = (rgb >> 8) & 0xff
    const b = rgb & 0xff
    const max = Math.max(r, g, b)
    return max > 0 && max < 150 // darkish, not near-white — a gray/ghost tone
  }
  return false
}

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
function scanRow(line: import('@xterm/xterm').IBufferLine, cols: number): SuggestionScan | null {
  const cell = line.getCell(0)
  if (!cell) return null
  // find the prompt marker, allowing a leading box border "│" and padding
  let markerCol = -1
  for (let x = 0; x < Math.min(cols, 8); x++) {
    const c = line.getCell(x, cell)
    if (!c) continue
    if (PROMPT_MARKERS.has(c.getChars())) {
      markerCol = x
      break
    }
  }
  if (markerCol < 0) return null
  let raw = ''
  let hasDim = false
  let hasTyped = false
  for (let x = markerCol + 1; x < cols; x++) {
    const c = line.getCell(x, cell)
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

/**
 * Scrape Claude Code's suggested next prompt (its grayed ghost text) out of the
 * terminal's input box. Returns null when nothing suggestion-like is present.
 * Read-only: reuses what Claude Code already rendered — no extra API call.
 */
export function readInputSuggestion(tabId: TabId): string | null {
  const term = entries.get(tabId)?.term
  if (!term) return null
  const buf = term.buffer.active
  // the input box sits at the bottom of the viewport; scan the last rows up for
  // the bottom-most prompt-marker line — that's the live input line
  const bottom = buf.baseY + term.rows - 1
  for (let y = bottom; y >= Math.max(0, bottom - 14); y--) {
    const line = buf.getLine(y)
    if (!line) continue
    const scan = scanRow(line, term.cols)
    if (!scan) continue
    // the user is typing (or has text) → no suggestion to mirror
    if (scan.hasTyped) return null
    // an all-dim (or empty-but-dim) input line is a pure suggestion
    return scan.hasDim && scan.raw ? scan.raw : null
  }
  return null
}

// test hook (CDP/DevTools): what the scraper extracts for a tab right now.
;(window as unknown as Record<string, unknown>).__readInputSuggestion = readInputSuggestion

// The agents overview's footer hint line — the one part of that view that is
// reliably distinguishable from the normal prompt view (both render an input
// row between plain "────" separators, so the input row itself can't be used).
const AGENTS_FOOTER_RE = /enter to return|space to reply|ctrl\+x to delete/

/**
 * Is Claude Code's agents overview (opened with ← on an empty prompt) showing
 * in this tab's terminal? Detected by its footer hint in the bottom rows.
 */
export function agentsOverviewOpen(tabId: TabId): boolean {
  const term = entries.get(tabId)?.term
  if (!term) return false
  const buf = term.buffer.active
  const bottom = buf.baseY + term.rows - 1
  for (let y = bottom; y >= Math.max(0, bottom - 14); y--) {
    const text = buf.getLine(y)?.translateToString(true) ?? ''
    if (AGENTS_FOOTER_RE.test(text)) return true
  }
  return false
}

// test hook (CDP/DevTools): is the agents overview showing in a tab's terminal?
;(window as unknown as Record<string, unknown>).__agentsOverviewOpen = agentsOverviewOpen

// Debug helper for tuning the dim-detection against a live TUI: dumps the bottom
// rows with per-cell fg info so the isDimCell predicate can be calibrated.
// Exposed on window for CDP/E2E; harmless at runtime.
;(window as unknown as Record<string, unknown>).__readSuggestionDebug = (tabId: TabId) => {
  const term = entries.get(tabId)?.term
  if (!term) return null
  const buf = term.buffer.active
  const bottom = buf.baseY + term.rows - 1
  const rows: unknown[] = []
  const cell = buf.getLine(bottom)?.getCell(0)
  for (let y = bottom; y >= Math.max(0, bottom - 14); y--) {
    const line = buf.getLine(y)
    if (!line || !cell) continue
    const cells: unknown[] = []
    for (let x = 0; x < term.cols; x++) {
      const c = line.getCell(x, cell)
      if (!c) continue
      const ch = c.getChars()
      if (!ch.trim()) continue
      cells.push({
        x,
        ch,
        dim: c.isDim(),
        fgPalette: c.isFgPalette() ? c.getFgColor() : null,
        fgRGB: c.isFgRGB() ? c.getFgColor().toString(16) : null,
        fgDefault: c.isFgDefault()
      })
    }
    rows.push({ y, text: line.translateToString(true), cells })
  }
  return rows
}

/** Safe to call only while the container is visible (xterm mis-measures when hidden). */
export function fitTerm(tabId: TabId): void {
  const entry = entries.get(tabId)
  if (!entry) return
  if (entry.containerEl.offsetParent === null) return
  entry.fit.fit()
}

export function focusTerm(tabId: TabId): void {
  entries.get(tabId)?.term.focus()
}

export function disposeTerm(tabId: TabId): void {
  const entry = entries.get(tabId)
  if (!entry) return
  entry.term.dispose()
  entry.containerEl.remove()
  entries.delete(tabId)
  delete ((window as unknown as Record<string, unknown>).__terms as Record<TabId, Terminal>)?.[
    tabId
  ]
}
