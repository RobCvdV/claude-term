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
  onOpenActivity: () => void
  /** version of a downloaded update, or null — shows the "update ready" pill */
  updateVersion: string | null
  onInstallUpdate: () => void
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

const PREFIX_MAP: Record<string, string> = {
  bugfix: 'bug',
  feature: 'feat',
  chore: 'chore'
}

/** bugfix/feature/chore → bug/feat/chore; returns null for any other prefix. */
function shortenBranchPrefix(branch: string): { short: string; rest: string } | null {
  const slash = branch.indexOf('/')
  if (slash === -1) return null
  const short = PREFIX_MAP[branch.slice(0, slash)]
  if (!short) return null
  return { short, rest: branch.slice(slash + 1) }
}

/** Derive the small subtitle shown under a tab title from its git branch. */
function tabSubtitle(title: string, status: TabStatus | null | undefined): string {
  const branch = status?.git?.branch?.trim()
  if (!branch) return ''
  const parts = shortenBranchPrefix(branch)
  // Personal project / unrecognised prefix → show the full branch name.
  if (!parts) return branch
  const ticket = branch.match(/[A-Z]{2,}-\d+/)
  // Ticket already in the title → drop it from the subtitle, keep the rest.
  if (ticket && title.includes(ticket[0])) {
    const rest = parts.rest
      .replace(ticket[0], '')
      .replace(/^[-/]+/, '')
      .replace(/[-/]+$/, '')
    return rest ? `${parts.short}/${rest}` : parts.short
  }
  // No ticket in the title → full branch with the shortened prefix.
  return `${parts.short}/${parts.rest}`
}

/** Border/highlight for a tab: L/T/R lines when active, bottom line otherwise. */
function tabShadow(color: string | undefined, isActive: boolean): string | undefined {
  if (isActive) {
    const line = color || 'var(--border-active)'
    return `inset 2px 0 0 ${line}, inset -2px 0 0 ${line}, inset 0 2px 0 ${line}`
  }
  return color ? `inset 0 -2px 0 ${color}` : undefined
}

export function TabBar({
  tabs,
  activeId,
  statuses,
  colors,
  onSelect,
  onClose,
  onNewTab,
  onRename,
  onOpenActivity,
  updateVersion,
  onInstallUpdate
}: Props): React.JSX.Element {
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
      {tabs.map((tab) => {
        const isActive = tab.tabId === activeId
        const subtitle = tabSubtitle(tab.title, statuses[tab.tabId])
        const boxShadow = tabShadow(colors[tab.tabId], isActive)
        return (
          <div
            key={tab.tabId}
            className={`tab ${isActive ? 'active' : ''}`}
            style={boxShadow ? { boxShadow } : undefined}
            onMouseDown={(e) => {
              if (e.button === 0 && editingId !== tab.tabId) onSelect(tab.tabId)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
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
              <span className="tab-labels">
                <span className="tab-title">{tab.title}</span>
                {subtitle && <span className="tab-subtitle">{subtitle}</span>}
              </span>
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
        )
      })}
      <button className="new-tab" onClick={onNewTab} title="New session (⌘T)">
        +
      </button>
      {updateVersion && (
        <button
          className="update-pill"
          onClick={onInstallUpdate}
          title={`Update ${updateVersion} downloaded — click to restart & install`}
        >
          ⬆ Update {updateVersion}
        </button>
      )}
      <button
        className="clock-btn"
        onClick={onOpenActivity}
        title="Activity hours"
        aria-label="Activity hours"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
    </div>
  )
}
