import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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
