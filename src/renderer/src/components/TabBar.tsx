import { useEffect, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../../shared/types'

interface Props {
  tabs: TabInfo[]
  activeId: TabId | null
  statuses: Record<TabId, TabStatus | null>
  colors: Record<TabId, string>
  onSelect: (tabId: TabId) => void
  onClose: (tabId: TabId) => void
  onNewTab: () => void
  onRename: (tabId: TabId, title: string) => void
}

function dotClass(status: TabStatus | null | undefined): string {
  if (status?.activity === 'exited') return 'dot exited'
  // plain terminal (no claude session) — neutral dot
  if (!status?.claudeActive) return 'dot terminal'
  const map: Partial<Record<ActivityState, string>> = {
    busy: 'dot busy',
    'needs-attention': 'dot attention',
    idle: 'dot idle'
  }
  return map[status.activity] ?? 'dot idle'
}

export function TabBar({ tabs, activeId, statuses, colors, onSelect, onClose, onNewTab, onRename }: Props): React.JSX.Element {
  const [editingId, setEditingId] = useState<TabId | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  const commit = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <div className="tab-bar">
      <div className="tab-drag-region" />
      {tabs.map((tab) => (
        <div
          key={tab.tabId}
          className={`tab ${tab.tabId === activeId ? 'active' : ''}`}
          style={colors[tab.tabId] ? { boxShadow: `inset 0 -2px 0 ${colors[tab.tabId]}` } : undefined}
          onMouseDown={(e) => {
            if (e.button === 0 && editingId !== tab.tabId) onSelect(tab.tabId)
          }}
          onDoubleClick={() => {
            setEditingId(tab.tabId)
            setDraft(tab.title)
          }}
          title={tab.cwd}
        >
          <span className={dotClass(statuses[tab.tabId])} />
          {editingId === tab.tabId ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <span className="tab-title">{tab.title}</span>
          )}
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.tabId)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="new-tab" onClick={onNewTab} title="New session (⌘T)">
        +
      </button>
    </div>
  )
}
