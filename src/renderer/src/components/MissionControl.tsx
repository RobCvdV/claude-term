import { useEffect, useRef, useState } from 'react'
import type {
  ActivityState,
  CiInfo,
  GitInfo,
  ReviewItem,
  TabId,
  TabInfo,
  TabStatus
} from '../../../shared/types'
import { nameOf } from '../../../shared/status-folders'
import { ticketUrl } from '../../../shared/jira-labels'
import { useModalOverlay } from '../modal-overlay'
import { ciLabel, ciTone, prReviewLabel, prTone, ticketTone } from '../work-status'
import { readyToMerge, ticketDrift, ticketStage, tooFarBehind } from '../../../shared/work-rules'
import { useAppSettings } from '../use-app-settings'

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

/** A small action inside a card: runs without selecting the card. */
function ActionChip({
  label,
  title,
  run
}: {
  label: string
  title: string
  run: () => Promise<{ ok: boolean; error?: string }>
}): React.JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  return (
    <span
      role="button"
      className={`mission-action ${phase === 'done' ? 'tone-green' : phase === 'failed' ? 'tone-red' : ''}`}
      title={error ?? title}
      onClick={(e) => {
        e.stopPropagation()
        if (phase === 'busy' || phase === 'done') return
        setPhase('busy')
        void run().then((r) => {
          // ok=false without an error is a cancelled confirmation
          setPhase(r.ok ? 'done' : r.error ? 'failed' : 'idle')
          setError(r.error ?? null)
        })
      }}
    >
      {phase === 'busy'
        ? '…'
        : phase === 'done'
          ? '✓ moved'
          : phase === 'failed'
            ? `${label} failed`
            : label}
    </span>
  )
}

const moveTo = (key: string, stage: 'review' | 'deploy') => () =>
  window.claudeTerm.jiraMove(key, stage)

/** One repo's line: branch (Jira status), PR review, CI, local git counts,
 *  and what to do next — ready to merge, too far behind, a lagging ticket. */
function RepoWork({
  label,
  git,
  ci,
  behindThreshold
}: {
  label?: string
  git: GitInfo
  ci: CiInfo | null
  behindThreshold: number
}): React.JSX.Element {
  const { pr, ticket } = git
  const ready = readyToMerge(git, ci, behindThreshold)
  const behindFlag = tooFarBehind(git, behindThreshold)
  const drift = ticketDrift(git)
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
        {ready && <span className="mission-chip mission-ready">✓ ready to merge</span>}
        {pr ? (
          <LinkChip url={pr.url} className={prTone(pr)} title={pr.title}>
            ● PR #{pr.number} {prReviewLabel(pr)}
            {pr.comments ? <span className="dim"> · {pr.comments} 💬</span> : null}
          </LinkChip>
        ) : git.mergedPr ? (
          <LinkChip url={git.mergedPr.url} className="tone-magenta">
            PR #{git.mergedPr.number} merged
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
          <span
            className={`mission-chip mission-git ${behindFlag ? 'tone-orange' : ''}`}
            title={
              behindFlag ? `${git.behind} commits behind main — rebase before review` : undefined
            }
          >
            {git.changed > 0 && <span className="stat-changed">~{git.changed}</span>}
            {git.unpushed > 0 && <span className="stat-ahead">↑{git.unpushed}</span>}
            {git.behind > 0 && (
              <span className={behindFlag ? undefined : 'stat-behind'}>↓{git.behind}</span>
            )}
            {behindFlag && <span>rebase?</span>}
          </span>
        )}
        {ready && ticket && ticketStage(ticket) === 'review' && (
          <ActionChip
            label={`${ticket.key} → Deploy`}
            title="move the ticket to Deploy"
            run={moveTo(ticket.key, 'deploy')}
          />
        )}
      </div>
      {drift && (
        <div className="mission-row mission-drift">
          <span>⚠ {drift.text}</span>
          {drift.moveTo && ticket && (
            <ActionChip
              label={drift.moveTo === 'review' ? '→ Peer review' : '→ Deploy'}
              title={`move ${ticket.key} on the board`}
              run={moveTo(ticket.key, drift.moveTo)}
            />
          )}
        </div>
      )}
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
function summary(
  statuses: (TabStatus | null)[],
  behindThreshold: number
): { text: string; tone: string }[] {
  let ready = 0
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
      if (r.git && readyToMerge(r.git, r.ci, behindThreshold)) ready++
    }
  }
  return [
    { n: input, text: 'need input', tone: 'tone-red' },
    { n: failed, text: 'build failed', tone: 'tone-red' },
    { n: changes, text: 'changes requested', tone: 'tone-orange' },
    { n: building, text: 'building', tone: 'tone-orange' },
    { n: waiting, text: 'awaiting review', tone: 'tone-blue' },
    { n: ready, text: 'ready to merge', tone: 'tone-green' },
    { n: approved - ready, text: 'approved', tone: 'tone-green' }
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
  const settings = useAppSettings()
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  useEffect(() => {
    void window.claudeTerm.reviewQueue().then(setReviews)
    return window.claudeTerm.onReviewQueue(setReviews)
  }, [])
  const waiting = settings.reviewQueue ? reviews : []
  const todo = waiting.filter((r) => !r.myVerdict).length

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
            {summary(
              tabs.map((t) => statuses[t.tabId] ?? null),
              settings.behindThreshold
            ).map((c) => (
              <span key={c.text} className={c.tone}>
                {c.text}
              </span>
            ))}
            {todo > 0 && <span className="tone-magenta">{todo} to review</span>}
          </span>
          <button className="help-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>
        {waiting.length > 0 && (
          <div className="mission-reviews">
            <div className="mission-reviews-title">Waiting on your review</div>
            {waiting.map((r) => (
              <button
                key={r.url}
                className="mission-review"
                title={r.url}
                onClick={() => window.open(r.url)}
              >
                <span className="dim">{r.repo.split('/').pop()}</span>
                <span className="pr-number">#{r.number}</span>
                <span className="mission-review-title">{r.title}</span>
                {r.author && <span className="dim">{r.author}</span>}
                <span
                  className={
                    r.myVerdict === 'approved'
                      ? 'tone-green'
                      : r.myVerdict === 'changes'
                        ? 'tone-orange'
                        : 'tone-magenta'
                  }
                >
                  {r.myVerdict === 'approved'
                    ? 'you approved'
                    : r.myVerdict === 'changes'
                      ? 'you asked for changes'
                      : 'to review'}
                </span>
              </button>
            ))}
          </div>
        )}
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
                    behindThreshold={settings.behindThreshold}
                  />
                )}
                {extras
                  .filter((r) => r.git.branch)
                  .map((r) => (
                    <RepoWork
                      key={r.root}
                      label={nameOf(r.root)}
                      git={r.git}
                      ci={r.ci}
                      behindThreshold={settings.behindThreshold}
                    />
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
