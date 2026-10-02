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

export function setUiKeys(tabId: TabId, state: string | null): void {
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
