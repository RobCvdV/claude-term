import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../../shared/types'
import { bestScore } from '../palette-match'
import { needsInput } from '../attention'

export interface PaletteAction {
  id: string
  label: string
  /** right-aligned keyboard-shortcut hint */
  shortcut?: string
  run: () => void
}

interface Props {
  tabs: TabInfo[]
  statuses: Record<TabId, TabStatus | null>
  activeId: TabId | null
  actions: PaletteAction[]
  onSelectTab: (tabId: TabId) => void
  onClose: () => void
}

interface Item {
  key: string
  kind: 'tab' | 'action'
  label: string
  detail?: string
  shortcut?: string
  dot?: string
  run: () => void
}

function dotFor(status: TabStatus | null | undefined): string {
  if (status?.activity === 'exited') return 'dot exited'
  if (!status?.claudeActive) return 'dot terminal'
  const map: Partial<Record<ActivityState, string>> = {
    busy: 'dot busy',
    'needs-attention': 'dot attention',
    idle: 'dot idle'
  }
  return map[status.activity] ?? 'dot idle'
}

/** ⌘K palette: fuzzy-jump to a tab (by title/folder/branch) or run an app action. */
export function CommandPalette({
  tabs,
  statuses,
  activeId,
  actions,
  onSelectTab,
  onClose
}: Props): React.JSX.Element {
  const [query, setQueryState] = useState('')
  const [selected, setSelected] = useState(0)
  const setQuery = (q: string): void => {
    setQueryState(q)
    setSelected(0) // new filter → highlight back to the top hit
  }
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo((): Item[] => {
    const tabItems: (Item & { score: number })[] = []
    for (const tab of tabs) {
      const st = statuses[tab.tabId]
      const folder = st?.cwd?.split('/').filter(Boolean).pop() ?? ''
      const branch = st?.git?.branch ?? ''
      const score = bestScore(query, [tab.title, folder, branch])
      if (score === null) continue
      tabItems.push({
        key: `tab:${tab.tabId}`,
        kind: 'tab',
        label: tab.title,
        // folder is usually the title already — only show it when it adds info
        detail: [folder === tab.title ? '' : folder, branch].filter(Boolean).join(' · '),
        dot: dotFor(st),
        // waiting tabs surface first so the palette doubles as the attention list
        score: score + (needsInput(st) ? 100 : 0) + (tab.tabId === activeId ? -0.5 : 0),
        run: () => onSelectTab(tab.tabId)
      })
    }
    tabItems.sort((a, b) => b.score - a.score)
    const actionItems: (Item & { score: number })[] = []
    for (const a of actions) {
      const score = bestScore(query, [a.label])
      if (score === null) continue
      actionItems.push({ key: `act:${a.id}`, kind: 'action', score, ...a })
    }
    if (query) actionItems.sort((a, b) => b.score - a.score)
    return [...tabItems, ...actionItems]
  }, [tabs, statuses, activeId, actions, query, onSelectTab])

  // the list can shrink under the highlight (e.g. a status change) — clamp it
  const sel = Math.min(selected, Math.max(0, items.length - 1))

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const pick = (item: Item): void => {
    onClose()
    item.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Jump to tab or run a command…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter') {
              if (items[sel]) pick(items[sel])
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const delta = e.key === 'ArrowDown' ? 1 : -1
              setSelected((items.length + sel + delta) % Math.max(1, items.length))
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((item, index) => (
            <div
              key={item.key}
              data-index={index}
              className={`palette-item ${index === sel ? 'selected' : ''}`}
              onMouseMove={() => setSelected(index)}
              onClick={() => pick(item)}
            >
              {item.kind === 'tab' ? (
                <span className={item.dot} />
              ) : (
                <span className="palette-action-mark">›</span>
              )}
              <span className="palette-label">{item.label}</span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
              {item.shortcut && <span className="palette-shortcut">{item.shortcut}</span>}
            </div>
          ))}
          {items.length === 0 && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  )
}
