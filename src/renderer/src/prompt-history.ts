import type { TabId } from '../../shared/types'

/**
 * Terminal-style prompt history, per tab. Lives outside React so it survives the
 * PromptBox remount on every tab switch (the box is keyed by the active tab),
 * and is persisted into session.json so ↑ still recalls across a restart.
 */
const histories = new Map<TabId, string[]>()

// exposed for scripted E2E testing (CDP) — harmless at runtime. Guarded because
// this module is also imported by unit tests, which run without a DOM.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__promptHistories = histories
}

/** How much a tab keeps in memory for ↑ recall during the run. */
export const HISTORY_MAX = 100

/** How many entries survive a restart. Deliberately smaller than HISTORY_MAX:
 *  what you want back after a relaunch is the last handful, and session.json is
 *  rewritten (and snapshotted into session-backups/) on every change. */
export const HISTORY_PERSIST_MAX = 20

/** Entries longer than this are kept in memory but not persisted — a pasted wall
 *  of text is the least likely thing to arrow back to next launch and the most
 *  expensive to carry. */
export const HISTORY_PERSIST_MAX_ENTRY = 4_000

/** Total budget per tab, so no combination of entries can bloat session.json. */
export const HISTORY_PERSIST_MAX_TOTAL = 16_000

/** Record a submitted prompt. Consecutive duplicates collapse, as in a shell. */
export function pushPrompt(tabId: TabId, text: string): void {
  const list = histories.get(tabId) ?? []
  if (list[list.length - 1] !== text) list.push(text)
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
  histories.set(tabId, list)
}

/** The tab's history, oldest first. The live array — callers must not mutate it. */
export function promptHistoryFor(tabId: TabId): string[] {
  return histories.get(tabId) ?? []
}

/** Seed a restored tab's history from session.json. */
export function restorePromptHistory(tabId: TabId, list: string[] | undefined): void {
  if (!list?.length) return
  histories.set(tabId, list.slice(-HISTORY_MAX))
}

/** Drop a closed tab's history so it doesn't outlive the tab. */
export function forgetPromptHistory(tabId: TabId): void {
  histories.delete(tabId)
}

/**
 * The slice of a tab's history to write to disk: the newest entries, oldest
 * first, skipping ones too big to be worth carrying and stopping at the total
 * budget. Walks newest→oldest so a huge recent prompt can't starve the older
 * ones out of the file.
 */
export function historyToPersist(list: string[]): string[] {
  const kept: string[] = []
  let total = 0
  for (let i = list.length - 1; i >= 0 && kept.length < HISTORY_PERSIST_MAX; i--) {
    const entry = list[i]
    if (entry.length > HISTORY_PERSIST_MAX_ENTRY) continue
    if (total + entry.length > HISTORY_PERSIST_MAX_TOTAL) break
    total += entry.length
    kept.push(entry)
  }
  return kept.reverse()
}

/** What to persist for a tab, or undefined when there's nothing worth saving. */
export function persistedHistoryFor(tabId: TabId): string[] | undefined {
  const kept = historyToPersist(promptHistoryFor(tabId))
  return kept.length > 0 ? kept : undefined
}
