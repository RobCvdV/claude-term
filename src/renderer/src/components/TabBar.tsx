import { useEffect, useRef, useState } from 'react'
import type { ActivityState, HandoffTarget, TabId, TabInfo, TabStatus } from '../../../shared/types'
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
  /** to a new or another window — the right-click menu, or dragged out of the bar */
  onMove: (tabId: TabId, target: HandoffTarget) => void
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
  /** pulled away from the bar: letting go moves it to another window */
  out: boolean
}

/** Pointer travel before a press turns into a reorder rather than a click. */
const DRAG_THRESHOLD = 4
/** How far above/below the bar a dragged tab has to go to leave the window. */
const TEAR_OFF_DISTANCE = 30

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
  onMove,
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
    const barRect = bar.getBoundingClientRect()
    const tabId = tabs[index]?.tabId
    let dragging = false
    let last: MouseEvent | null = null
    const isOut = (ev: MouseEvent): boolean =>
      ev.clientY < barRect.top - TEAR_OFF_DISTANCE ||
      ev.clientY > barRect.bottom + TEAR_OFF_DISTANCE ||
      ev.clientX < 0 ||
      ev.clientX > window.innerWidth

    const update = (next: Drag | null): void => {
      dragRef.current = next
      setDrag(next)
    }

    const onPointer = (ev: MouseEvent): void => {
      last = ev
      const dx = ev.clientX - startX
      const out = isOut(ev)
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD && !out) return
      dragging = true
      const to = out ? index : dropIndex(centers, index, centers[index] + dx)
      update({ from: index, to, dx, width, out })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onPointer)
      window.removeEventListener('mouseup', onUp)
      const d = dragRef.current
      update(null)
      if (d?.out && last && tabId) {
        onMove(tabId, { kind: 'drop', x: last.screenX, y: last.screenY })
      } else if (d && d.to !== d.from) onReorder(d.from, d.to)
    }
    window.addEventListener('mousemove', onPointer)
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
            className={`tab ${isActive ? 'active' : ''} ${isDragged ? 'dragging' : ''} ${
              isDragged && drag?.out ? 'tearing' : ''
            }`}
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
              void window.claudeTerm.tabContextMenu().then((choice) => {
                if (choice?.kind === 'rename') {
                  setEditingId(tab.tabId)
                  setDraft(tab.title)
                } else if (choice?.kind === 'close') onClose(tab.tabId)
                else if (choice?.kind === 'move') onMove(tab.tabId, choice.target)
              })
            }}
            title={statuses[tab.tabId]?.cwd || tab.cwd}
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
