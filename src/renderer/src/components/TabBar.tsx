import { useEffect, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../../shared/types'
import { tabSubtitle } from '../tab-title'
import { dropIndex, shiftFor } from '../tab-reorder'

interface Props {
  tabs: TabInfo[]
  activeId: TabId | null
  statuses: Record<TabId, TabStatus | null>
  colors: Record<TabId, string>
  onSelect: (tabId: TabId) => void
  onClose: (tabId: TabId) => void
  onNewTab: () => void
  onRename: (tabId: TabId, title: string) => void
  onReorder: (from: number, to: number) => void
  onOpenActivity: () => void
  /** version of a downloaded update, or null — shows the "update ready" pill */
  updateVersion: string | null
  onInstallUpdate: () => void
  /** tabs blocked on a dialog — drives the ⚠ pill; click jumps to the next one */
  attentionCount: number
  onJumpAttention: () => void
}

interface Drag {
  from: number
  to: number
  /** live pointer offset from where the drag started */
  dx: number
  /** width of the dragged tab — the slot pitch the others shift by */
  width: number
}

/** Pointer travel before a press turns into a reorder rather than a click. */
const DRAG_THRESHOLD = 4

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
  onReorder,
  onOpenActivity,
  updateVersion,
  onInstallUpdate,
  attentionCount,
  onJumpAttention
}: Props): React.JSX.Element {
  const [editingId, setEditingId] = useState<TabId | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // mirrors `drag` so the mouseup listener can read it without re-subscribing
  const dragRef = useRef<Drag | null>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  const commit = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  const startDrag = (e: React.MouseEvent<HTMLElement>, index: number): void => {
    const bar = e.currentTarget.parentElement
    if (!bar) return
    // measure once: every slot keeps its start geometry, the tabs just slide
    const rects = Array.from(bar.querySelectorAll<HTMLElement>('.tab')).map((n) =>
      n.getBoundingClientRect()
    )
    const centers = rects.map((r) => r.left + r.width / 2)
    const width = rects[index]?.width ?? 0
    const startX = e.clientX
    let dragging = false

    const update = (next: Drag | null): void => {
      dragRef.current = next
      setDrag(next)
    }

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD) return
      dragging = true
      update({ from: index, to: dropIndex(centers, index, centers[index] + dx), dx, width })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const d = dragRef.current
      update(null)
      if (d && d.to !== d.from) onReorder(d.from, d.to)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className={`tab-bar ${drag ? 'reordering' : ''}`}>
      <div className="tab-drag-region" />
      {tabs.map((tab, index) => {
        const isActive = tab.tabId === activeId
        const subtitle = tabSubtitle(tab.title, statuses[tab.tabId])
        const boxShadow = tabShadow(colors[tab.tabId], isActive)
        const isDragged = drag?.from === index
        const shift = !drag
          ? 0
          : isDragged
            ? drag.dx
            : shiftFor(index, drag.from, drag.to, drag.width)
        return (
          <div
            key={tab.tabId}
            className={`tab ${isActive ? 'active' : ''} ${isDragged ? 'dragging' : ''}`}
            style={{
              ...(boxShadow ? { boxShadow } : null),
              ...(shift ? { transform: `translateX(${shift}px)` } : null)
            }}
            onMouseDown={(e) => {
              if (e.button !== 0 || editingId === tab.tabId) return
              onSelect(tab.tabId)
              if (!(e.target as HTMLElement).closest('.tab-close')) startDrag(e, index)
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
      {attentionCount > 0 && (
        <button
          className="attention-pill"
          onClick={onJumpAttention}
          title="Jump to the next tab waiting for input (⇧⌘A)"
        >
          {attentionCount} waiting
        </button>
      )}
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
