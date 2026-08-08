import { useEffect, useRef, useState } from 'react'
import type { ActivityState, TabId, TabInfo, TabStatus } from '../../../shared/types'

interface Props {
  tabs: TabInfo[]
  statuses: Record<TabId, TabStatus | null>
  colors: Record<TabId, string>
  activeId: TabId | null
  onSelectTab: (tabId: TabId) => void
  onClose: () => void
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

function activityLabel(status: TabStatus | null, now: number): string {
  if (!status?.claudeActive) return status?.activity === 'exited' ? 'exited' : 'terminal'
  if (status.activity === 'busy') {
    if (!status.busySince) return 'working'
    const secs = Math.max(0, Math.floor((now - status.busySince) / 1000))
    const m = Math.floor(secs / 60)
    return m > 0 ? `working ${m}m${String(secs % 60).padStart(2, '0')}s` : `working ${secs}s`
  }
  if (status.activity === 'needs-attention') return 'needs input'
  return status.activity
}

/** ⌘E overview: every tab at a glance — activity + elapsed, folder/branch,
 *  context %, CI state and a one-line "doing" snippet. Click a card to go. */
export function MissionControl({
  tabs,
  statuses,
  colors,
  activeId,
  onSelectTab,
  onClose
}: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // "doing" snippets: fetched when a card first appears, refreshed when its
  // tab's turn ends (busy → not-busy) — the moment the transcript has news.
  const [doing, setDoing] = useState<Record<TabId, string>>({})
  const prevActivity = useRef<Record<TabId, ActivityState>>({})
  useEffect(() => {
    for (const tab of tabs) {
      const activity = statuses[tab.tabId]?.activity ?? 'starting'
      const known = tab.tabId in prevActivity.current
      const prev = prevActivity.current[tab.tabId]
      prevActivity.current[tab.tabId] = activity
      if (!known || (prev === 'busy' && activity !== 'busy')) {
        void window.claudeTerm.missionDoing(tab.tabId).then((text) => {
          if (text) setDoing((d) => ({ ...d, [tab.tabId]: text }))
        })
      }
    }
  }, [tabs, statuses])

  const pick = (tabId: TabId): void => {
    onClose()
    onSelectTab(tabId)
  }

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div className="activity-panel mission-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <span className="activity-title">Mission control</span>
          <button className="help-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        <div className="mission-grid">
          {tabs.map((tab) => {
            const st = statuses[tab.tabId] ?? null
            const folder = st?.cwd?.split('/').filter(Boolean).pop() ?? ''
            const branch = st?.git?.branch ?? ''
            const ctx = st?.payload?.context_window?.used_percentage
            const ci = st?.ci
            return (
              <button
                key={tab.tabId}
                className={`mission-card ${tab.tabId === activeId ? 'mission-active' : ''}`}
                style={colors[tab.tabId] ? { borderColor: colors[tab.tabId] } : undefined}
                onClick={() => pick(tab.tabId)}
              >
                <div className="mission-row">
                  <span className={dotFor(st)} />
                  <span className="mission-title">{tab.title}</span>
                  <span className="mission-activity">{activityLabel(st, now)}</span>
                </div>
                <div className="mission-row mission-meta">
                  <span title={st?.cwd}>{folder}</span>
                  {branch && <span className="mission-branch">{branch}</span>}
                  {ctx != null && (
                    <span className={ctx >= 78 ? 'ctx-red' : ctx >= 60 ? 'ctx-orange' : ''}>
                      ctx {ctx}%
                    </span>
                  )}
                  {ci && (
                    <span className={`ci-dot ci-${ci.state}`} title={`${ci.provider}: ${ci.state}`}>
                      ●
                    </span>
                  )}
                </div>
                {doing[tab.tabId] && <div className="mission-doing">{doing[tab.tabId]}</div>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
