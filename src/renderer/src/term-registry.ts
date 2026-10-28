import { Terminal, type IBufferLine } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import type { TabId } from '../../shared/types'
import {
  agentsOverviewInRows,
  dialogOpenInRows,
  hasPromptInputRow,
  suggestionInLines
} from './terminal-scan'
import { fileLinkProvider, fileLinksInLine } from './terminal-links'
import { isFocusToggle } from './focus-policy'
import { cwdFromOsc7 } from './tab-title'
import { setTermView, termView, uiKeysOwner } from './ui-keys'

export interface TermEntry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  serialize: SerializeAddon
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

/** App registers this to move focus to the prompt box on ⌥Tab — the other half
 *  of the box's own ⌥Tab, so one combo toggles between the two. Returns false
 *  when there is no box to focus (a plain terminal), and the key falls through
 *  to the PTY as before. */
let focusToggleHandler: (tabId: TabId) => boolean = () => false
export function setTerminalFocusToggleHandler(fn: (tabId: TabId) => boolean): void {
  focusToggleHandler = fn
}

/** App registers this to follow the folder the tab's shell reports (OSC 7). */
let cwdHandler: (tabId: TabId, cwd: string) => void = () => {}
export function setTerminalCwdHandler(fn: (tabId: TabId, cwd: string) => void): void {
  cwdHandler = fn
}

/** Our zsh preexec/precmd report: base64 command line, empty when back at the prompt. */
const SHELL_CMD_OSC = 'ClaudeTermCmd='

export function decodeShellCommand(b64: string): string | null {
  if (!b64) return null
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes).trim() || null
  } catch {
    return null
  }
}

function ensureRouting(): void {
  if (dataUnsub) return
  dataUnsub = window.claudeTerm.onPtyData((tabId, data) => {
    entries.get(tabId)?.term.write(data)
  })
}

export function createTerm(tabId: TabId, size?: { cols: number; rows: number }): TermEntry {
  ensureRouting()
  const existing = entries.get(tabId)
  if (existing) return existing

  const term = new Terminal({
    ...size,
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
  const search = new SearchAddon()
  term.loadAddon(search)
  const serialize = new SerializeAddon()
  term.loadAddon(serialize)

  // Cmd/Ctrl-click URLs to open them in the default browser (iTerm2 style).
  // A plain click falls through to xterm's normal selection behaviour.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) window.claudeTerm.openExternal(uri)
    })
  )

  // …and the same for a `src/main/ipc.ts:403`, which opens the file window there
  term.registerLinkProvider(
    fileLinkProvider(term, (raw) => void window.claudeTerm.openFileLink(tabId, raw))
  )

  const containerEl = document.createElement('div')
  containerEl.className = 'term-container'
  term.open(containerEl)

  term.onData((data) => window.claudeTerm.ptyInput(tabId, data))
  term.onResize(({ cols, rows }) => window.claudeTerm.ptyResize(tabId, cols, rows))
  term.parser.registerOscHandler(1337, (data) => {
    if (!data.startsWith(SHELL_CMD_OSC)) return false
    window.claudeTerm.reportShellCommand(
      tabId,
      decodeShellCommand(data.slice(SHELL_CMD_OSC.length))
    )
    return true
  })
  term.parser.registerOscHandler(7, (data) => {
    const cwd = cwdFromOsc7(data)
    if (cwd) cwdHandler(tabId, cwd)
    return true
  })

  // Return true so xterm still sends the key to the PTY (Claude Code closes its
  // overlay); after that dispatches, App decides whether to refocus the box.
  term.attachCustomKeyEventHandler((e) => {
    // ⌥Tab is ours: it hands focus back to the prompt box rather than reaching
    // the PTY, where Option+Tab was only ever another Tab. Claimed on keydown
    // (which is where xterm would emit the data) and only when a box exists —
    // in a plain terminal it still falls through.
    //
    // preventDefault is on us: returning false only stops xterm from sending
    // the key, it does not suppress the browser's own Tab focus traversal —
    // which otherwise walks straight past the box to the next control.
    if (e.type === 'keydown' && isFocusToggle(e)) {
      if (!focusToggleHandler(tabId)) return true
      e.preventDefault()
      e.stopPropagation()
      return false
    }
    if (e.type === 'keydown' && e.key === 'Escape') {
      window.claudeTerm.logKey(tabId, 'Escape', 'terminal')
      setTermView(tabId, null)
      window.setTimeout(() => escapeHandler(tabId), 0)
    }
    // ⌃O toggles the transcript shut too: back to the box, as Esc would
    if (
      e.type === 'keydown' &&
      e.ctrlKey &&
      e.code === 'KeyO' &&
      termView(tabId) === 'transcript'
    ) {
      setTermView(tabId, null)
      window.setTimeout(() => focusToggleHandler(tabId), 0)
    }
    return true
  })

  const entry: TermEntry = { term, fit, search, serialize, containerEl }
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

/** How many rows up from the bottom the TUI scrapers look. */
const SCAN_ROWS = 15

/** The bottom rows of a tab's terminal as plain text, bottom-most first. */
function bottomRows(tabId: TabId, count = SCAN_ROWS): string[] {
  const term = entries.get(tabId)?.term
  if (!term) return []
  const buf = term.buffer.active
  const bottom = buf.baseY + term.rows - 1
  const rows: string[] = []
  for (let y = bottom; y >= Math.max(0, bottom - (count - 1)); y--) {
    rows.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  return rows
}

/**
 * The whole visible screen of a tab, top row first.
 *
 * This — not a stream of PTY bytes — is what "what is this session doing right
 * now" means for a full-screen TUI: Claude Code redraws in place on the
 * alternate screen buffer, so its byte stream is mostly cursor moves and spinner
 * frames, and there is no scrollback behind it to send either.
 */
export function visibleScreen(tabId: TabId): string[] {
  const term = entries.get(tabId)?.term
  if (!term) return []
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    rows.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  // a TUI leaves the unused bottom of the screen blank
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop()
  return rows
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
  const bottom = buf.baseY + term.rows - 1
  const lines: (IBufferLine | undefined)[] = []
  for (let y = bottom; y >= Math.max(0, bottom - (SCAN_ROWS - 1)); y--) lines.push(buf.getLine(y))
  return suggestionInLines(lines, term.cols)
}

// test hook (CDP/DevTools): what the scraper extracts for a tab right now.
;(window as unknown as Record<string, unknown>).__readInputSuggestion = readInputSuggestion

/**
 * Is Claude Code's agents overview (opened with ← on an empty prompt) showing
 * in this tab's terminal? Detected by its footer hint in the bottom rows.
 */
export function agentsOverviewOpen(tabId: TabId): boolean {
  return agentsOverviewInRows(bottomRows(tabId))
}

/**
 * Is the tab's terminal showing a dialog the user must drive with the keyboard
 * (permission prompt, picker, agents overview)? Drives the focus loans: while
 * this is true the terminal keeps focus, and the moment it stops being true the
 * prompt box takes focus back. A tab with no terminal yet counts as no dialog.
 */
export function terminalDialogOpen(tabId: TabId): boolean {
  const owner = uiKeysOwner(tabId)
  return owner ? owner === 'tui' : dialogOpenInRows(bottomRows(tabId))
}

/**
 * Is the terminal at Claude Code's plain prompt — input line rendered, no
 * dialog/overlay? Esc pressed here is meant for Claude Code itself (clear
 * input, double-Esc rewind), not for dismissing anything.
 */
export function terminalAtNormalInput(tabId: TabId): boolean {
  const owner = uiKeysOwner(tabId)
  if (owner) return owner === 'prompt'
  const rows = bottomRows(tabId)
  return hasPromptInputRow(rows) && !dialogOpenInRows(rows)
}

// test hooks (CDP/DevTools): what the TUI scrapers see for a tab right now.
;(window as unknown as Record<string, unknown>).__agentsOverviewOpen = agentsOverviewOpen
;(window as unknown as Record<string, unknown>).__terminalDialogOpen = terminalDialogOpen
;(window as unknown as Record<string, unknown>).__fileLinksInViewport = (tabId: TabId) => {
  const term = entries.get(tabId)?.term
  if (!term) return []
  const buf = term.buffer.active
  const out: { y: number; text: string; x: number }[] = []
  for (let y = buf.baseY + 1; y <= buf.baseY + term.rows; y++) {
    const line = buf.getLine(y - 1)
    if (!line) continue
    for (const link of fileLinksInLine(line, term.cols, y)) {
      out.push({ y, text: link.text, x: link.range.start.x })
    }
  }
  return out
}

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

/** A tab's screen and scrollback as escape sequences, once pending writes have landed. */
export async function serializeTerm(
  tabId: TabId
): Promise<{ screen: string; cols: number; rows: number }> {
  const entry = entries.get(tabId)
  if (!entry) return { screen: '', cols: 80, rows: 24 }
  await new Promise<void>((resolve) => entry.term.write('', resolve))
  const { term } = entry
  return { screen: entry.serialize.serialize(), cols: term.cols, rows: term.rows }
}

/** A tab arriving from another window: its terminal, already showing what it showed there. */
export function primeTerm(tabId: TabId, screen: string, cols: number, rows: number): void {
  const { term } = createTerm(tabId, { cols, rows })
  if (screen) term.write(screen)
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
