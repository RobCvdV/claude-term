import { useEffect, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../../shared/types'

interface Props {
  tabs: TabInfo[]
  activeId: TabId | null
  statuses: Record<TabId, TabStatus | null>
  onSelect: (tabId: TabId) => void
  onClose: (tabId: TabId) => void
  onNewTab: () => void
  onRename: (tabId: TabId, title: string) => void
}

function dotClass(activity: ActivityState | undefined): string {
  switch (activity) {
    case 'busy':
      return 'dot busy'
    case 'needs-attention':
      return 'dot attention'
    case 'exited':
    case 'ended':
      return 'dot exited'
    case 'idle':
      return 'dot idle'
    default:
      return 'dot starting'
  }
}

export function TabBar({ tabs, activeId, statuses, onSelect, onClose, onNewTab, onRename }: Props): React.JSX.Element {
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
          onMouseDown={(e) => {
            if (e.button === 0 && editingId !== tab.tabId) onSelect(tab.tabId)
          }}
          onDoubleClick={() => {
            setEditingId(tab.tabId)
            setDraft(tab.title)
          }}
          title={tab.cwd}
        >
          <span className={dotClass(statuses[tab.tabId]?.activity)} />
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
