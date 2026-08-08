import type { TabId, TabStatus } from '../../shared/types'

/** The tab's claude session is blocked on a dialog the user must answer. */
export function needsInput(status: TabStatus | null | undefined): boolean {
  return !!status?.claudeActive && status.activity === 'needs-attention'
}

/**
 * The next tab after `activeId` (in tab order, wrapping) that is blocked on
 * input. The active tab itself never qualifies — when it's the only one
 * waiting, you're already there and this returns null.
 */
export function nextAttentionTab(
  tabs: { tabId: TabId }[],
  statuses: Record<TabId, TabStatus | null>,
  activeId: TabId | null
): TabId | null {
  const n = tabs.length
  if (n === 0) return null
  const start = activeId ? tabs.findIndex((t) => t.tabId === activeId) : -1
  for (let i = 1; i <= n; i++) {
    const tab = tabs[(start + i + n) % n]
    if (tab.tabId !== activeId && needsInput(statuses[tab.tabId])) return tab.tabId
  }
  return null
}
