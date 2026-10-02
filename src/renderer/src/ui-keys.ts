import type { TabId } from '../../shared/types'

/**
 * Who holds Claude Code's keyboard, as the term-bridge mod inside the session
 * reports it: 'tui' while a dialog, menu or other view replaces the input
 * line, 'prompt' at the plain input line, null when the mod can't tell (text
 * in the TUI's own input, no mod loaded) and the screen scrapers decide.
 */
export type UiKeysOwner = 'tui' | 'prompt' | null

export function ownerOfKeysState(state: string | null): UiKeysOwner {
  if (state === 'dialog' || state === 'no_composer') return 'tui'
  if (state === 'prompt') return 'prompt'
  return null
}

const owners = new Map<TabId, UiKeysOwner>()
const listeners = new Set<(tabId: TabId, owner: UiKeysOwner) => void>()
const draftListeners = new Set<(tabId: TabId, draft: string) => void>()

/** `draft`: text in the TUI's own input line, reported with the 'typing' state. */
export function setUiKeys(tabId: TabId, state: string | null, draft: string | null = null): void {
  if (draft) for (const cb of draftListeners) cb(tabId, draft)
  const owner = ownerOfKeysState(state)
  if (owners.get(tabId) === owner) return
  owners.set(tabId, owner)
  for (const cb of listeners) cb(tabId, owner)
}

export function uiKeysOwner(tabId: TabId): UiKeysOwner {
  return owners.get(tabId) ?? null
}

export function onUiKeys(cb: (tabId: TabId, owner: UiKeysOwner) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function onTuiDraft(cb: (tabId: TabId, draft: string) => void): () => void {
  draftListeners.add(cb)
  return () => draftListeners.delete(cb)
}

/**
 * The terminal view a Ctrl key from the prompt box opened, while focus is
 * over there for it: how it closes decides when focus comes back.
 */
export type TermView = 'history' | 'transcript'
const views = new Map<TabId, TermView>()

export function setTermView(tabId: TabId, view: TermView | null): void {
  if (view) views.set(tabId, view)
  else views.delete(tabId)
}

export function termView(tabId: TabId): TermView | null {
  return views.get(tabId) ?? null
}
