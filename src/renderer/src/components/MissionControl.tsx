import { useEffect, useRef, useState } from 'react'
import type {
  ActivityState,
  CiInfo,
  GitInfo,
  TabId,
  TabInfo,
  TabStatus
} from '../../../shared/types'
import { nameOf } from '../../../shared/status-folders'
import { ticketUrl } from '../../../shared/jira-labels'
import { useModalOverlay } from '../modal-overlay'
import { ciLabel, ciTone, prReviewLabel, prTone, ticketTone } from '../work-status'

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

const CI_NAMES: Record<CiInfo['provider'], string> = {
  jenkins: 'Jenkins',
  circleci: 'CircleCI',
  actions: 'Actions'
}

/** A chip inside a card that opens its link instead of selecting the card. */
function LinkChip({
  url,
  className,
  title,
  children
}: {
  url: string
  className: string
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      role="link"
      className={`mission-chip ${className}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        window.open(url)
      }}
    >
      {children}
    </span>
  )
}

/** One repo's line: branch (Jira status), PR review, CI, local git counts. */
function RepoWork({
  label,
  git,
  ci
}: {
  label?: string
  git: GitInfo
  ci: CiInfo | null
}): React.JSX.Element {
  const { pr, ticket } = git
  return (
    <div className="mission-work">
      <div className="mission-row mission-branch-row">
        {label && <span className="mission-repo">{label}</span>}
        <span className="mission-branch" title={git.branch}>
          {git.branch}
        </span>
        {ticket && (
          <LinkChip
            url={ticketUrl(ticket.key)}
            className={`mission-pill ${ticketTone(ticket)}`}
            title={`${ticket.key}: ${ticket.summary}${ticket.assignee ? ` — ${ticket.assignee}` : ''}`}
          >
            {ticket.status}
          </LinkChip>
        )}
      </div>
      <div className="mission-row mission-chips">
        {pr ? (
          <LinkChip url={pr.url} className={prTone(pr)} title={pr.title}>
            ● PR #{pr.number} {prReviewLabel(pr)}
            {pr.comments ? <span className="dim"> · {pr.comments} 💬</span> : null}
          </LinkChip>
        ) : (
          git.unpushed === 0 &&
          git.changed === 0 &&
          git.branch &&
          !['main', 'master', 'develop'].includes(git.branch) && (
            <span className="mission-chip tone-dim">no PR</span>
          )
        )}
        {ci && (
          <LinkChip
            url={ci.url}
            className={ciTone(ci)}
            title={`${CI_NAMES[ci.provider]}${ci.detail ? ` ${ci.detail}` : ''}`}
          >
            <span className={ci.state === 'running' ? 'ci-running' : undefined}>●</span>{' '}
            {CI_NAMES[ci.provider]} {ciLabel(ci)}
            {ci.state === 'running' && ci.progress != null && (
              <span className="mission-bar">
                <span style={{ width: `${ci.progress}%` }} />
              </span>
            )}
          </LinkChip>
        )}
        {(git.changed > 0 || git.unpushed > 0 || git.behind > 0) && (
          <span className="mission-chip mission-git">
            {git.changed > 0 && <span className="stat-changed">~{git.changed}</span>}
            {git.unpushed > 0 && <span className="stat-ahead">↑{git.unpushed}</span>}
            {git.behind > 0 && <span className="stat-behind">↓{git.behind}</span>}
          </span>
        )}
      </div>
    </div>
  )
}

/** Something on this tab wants you: input, a red build, requested changes. */
function needsYou(st: TabStatus | null): boolean {
  if (!st) return false
  if (st.claudeActive && st.activity === 'needs-attention') return true
  const repos = [
    { git: st.git, ci: st.ci },
    ...st.extraRepos.map((r) => ({ git: r.git, ci: r.ci }))
  ]
  return repos.some((r) => r.ci?.state === 'failed' || r.git?.pr?.review === 'changes')
}

/** Counts across all tabs for the header, e.g. "1 needs input · 2 approved". */
function summary(statuses: (TabStatus | null)[]): { text: string; tone: string }[] {
  let input = 0
  let failed = 0
  let building = 0
  let changes = 0
  let approved = 0
  let waiting = 0
  for (const st of statuses) {
    if (!st) continue
    if (st.claudeActive && st.activity === 'needs-attention') input++
    for (const r of [{ git: st.git, ci: st.ci }, ...st.extraRepos]) {
      if (r.ci?.state === 'failed') failed++
      if (r.ci?.state === 'running') building++
      const review = r.git?.pr && !r.git.pr.draft ? r.git.pr.review : null
      if (review === 'changes') changes++
      if (review === 'approved') approved++
      if (review === 'pending') waiting++
    }
  }
  return [
    { n: input, text: 'need input', tone: 'tone-red' },
    { n: failed, text: 'build failed', tone: 'tone-red' },
    { n: changes, text: 'changes requested', tone: 'tone-orange' },
    { n: building, text: 'building', tone: 'tone-orange' },
    { n: waiting, text: 'awaiting review', tone: 'tone-blue' },
    { n: approved, text: 'approved', tone: 'tone-green' }
  ]
    .filter((c) => c.n > 0)
    .map((c) => ({ text: `${c.n} ${c.text}`, tone: c.tone }))
}

/** ⌘E overview: every tab at a glance — activity + elapsed, context %, and per
 *  repo the branch with its Jira status, PR review, CI (with progress) and
 *  local git counts, plus a one-line "doing" snippet. Click a card to go; click
 *  a chip to open the ticket, PR or build. */
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

  const panelRef = useModalOverlay<HTMLDivElement>(onClose)

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
      <div
        ref={panelRef}
        tabIndex={-1}
        className="activity-panel mission-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="activity-head">
          <span className="activity-title">Mission control</span>
          <span className="mission-summary">
            {summary(tabs.map((t) => statuses[t.tabId] ?? null)).map((c) => (
              <span key={c.text} className={c.tone}>
                {c.text}
              </span>
            ))}
          </span>
          <button className="help-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        <div className="mission-grid">
          {tabs.map((tab) => {
            const st = statuses[tab.tabId] ?? null
            const folder = st?.cwd?.split('/').filter(Boolean).pop() ?? ''
            const ctx = st?.payload?.context_window?.used_percentage
            const extras = st?.extraRepos ?? []
            return (
              <button
                key={tab.tabId}
                className={`mission-card ${tab.tabId === activeId ? 'mission-active' : ''} ${needsYou(st) ? 'mission-alert' : ''}`}
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
                  {ctx != null && (
                    <span className={ctx >= 78 ? 'ctx-red' : ctx >= 60 ? 'ctx-orange' : ''}>
                      ctx {ctx}%
                    </span>
                  )}
                </div>
                {st?.git?.branch && (
                  <RepoWork
                    label={extras.length > 0 ? folder : undefined}
                    git={st.git}
                    ci={st.ci}
                  />
                )}
                {extras
                  .filter((r) => r.git.branch)
                  .map((r) => (
                    <RepoWork key={r.root} label={nameOf(r.root)} git={r.git} ci={r.ci} />
                  ))}
                {doing[tab.tabId] && <div className="mission-doing">{doing[tab.tabId]}</div>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
