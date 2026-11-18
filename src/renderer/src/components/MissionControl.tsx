import { useEffect, useRef, useState } from 'react'
import type {
  ActivityState,
  CiInfo,
  E2eRun,
  GitInfo,
  ReviewItem,
  TabId,
  TabInfo,
  TabStatus
} from '../../../shared/types'
import { nameOf } from '../../../shared/status-folders'
import { isTrunkBranch } from '../../../shared/repo-links'
import {
  activityLabel,
  CI_NAMES,
  dotFor,
  e2eDot,
  e2eRunLabel,
  e2eTone,
  moveTo,
  reviewVerdict
} from '../work-status'
import { e2eSummary } from '../../../shared/e2e'
import { readyToMerge, ticketDrift, ticketStage, tooFarBehind } from '../../../shared/work-rules'
import { useAppSettings } from '../use-app-settings'
import { ActionChip, CiChip, LinkChip, PrChip, TicketPill } from './mission-parts'
import { useNow } from '../use-now'

interface Props {
  tabs: TabInfo[]
  statuses: Record<TabId, TabStatus | null>
  colors: Record<TabId, string>
  activeId: TabId | null
  onSelectTab: (tabId: TabId) => void
}

/** One repo's line: branch (Jira status), PR review, CI, local git counts,
 *  and what to do next — ready to merge, too far behind, a lagging ticket. */
function RepoWork({
  label,
  git,
  ci,
  e2e = [],
  behindThreshold
}: {
  label?: string
  git: GitInfo
  ci: CiInfo | null
  e2e?: E2eRun[]
  behindThreshold: number
}): React.JSX.Element {
  const { pr, ticket } = git
  const ready = readyToMerge(git, ci, behindThreshold)
  // e2e doesn't hold a merge back, but a failing group is worth a second look
  const e2eFails = e2eSummary(e2e)?.state === 'failed'
  const behindFlag = tooFarBehind(git, behindThreshold)
  const drift = ticketDrift(git)
  return (
    <div className="mission-work">
      <div className="mission-row mission-branch-row">
        {label && <span className="mission-repo">{label}</span>}
        <span className="mission-branch">{git.branch}</span>
        {ticket && <TicketPill ticket={ticket} />}
      </div>
      {(ticket?.summary || pr?.title) && (
        <div className="mission-topic">{ticket?.summary || pr?.title}</div>
      )}
      <div className="mission-row mission-chips">
        {ready &&
          (e2eFails ? (
            <span className="mission-chip tone-orange" title="approved and green, but e2e fails">
              ✓ ready — E2E fails, merge anyway?
            </span>
          ) : (
            <span className="mission-chip mission-ready">✓ ready to merge</span>
          ))}
        {pr ? (
          <PrChip pr={pr} />
        ) : git.mergedPr ? (
          <LinkChip url={git.mergedPr.url} className="tone-blue">
            PR #{git.mergedPr.number} merged
          </LinkChip>
        ) : (
          git.branch &&
          !isTrunkBranch(git.branch) && <span className="mission-chip tone-dim">no PR</span>
        )}
        {ci && (
          <CiChip
            ci={ci}
            name={CI_NAMES[ci.provider]}
            title={`${CI_NAMES[ci.provider]}${ci.detail ? ` ${ci.detail}` : ''}`}
          />
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
      {e2e.length > 0 && (
        <div className="mission-row mission-chips">
          {e2e.map((run) => (
            <LinkChip
              key={run.url}
              url={run.url}
              className={e2eTone(run.state)}
              title={`E2E ${run.group}${run.build ? ` ${run.build}` : ''} — open in AWS Device Farm`}
            >
              <span className={e2eDot(run.state)}>●</span> {run.group} · {e2eRunLabel(run)}
              {run.state === 'running' && run.jobsTotal > 0 && (
                <span className="mission-bar">
                  <span style={{ width: `${(run.jobsDone / run.jobsTotal) * 100}%` }} />
                </span>
              )}
            </LinkChip>
          ))}
        </div>
      )}
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
    { git: st.git, ci: st.ci, e2e: st.e2e },
    ...st.extraRepos.map((r) => ({ git: r.git, ci: r.ci, e2e: r.e2e }))
  ]
  return repos.some(
    (r) =>
      r.ci?.state === 'failed' ||
      r.git?.pr?.review === 'changes' ||
      !!r.e2e?.some((run) => run.state === 'failed')
  )
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
  let e2eFailed = 0
  for (const st of statuses) {
    if (!st) continue
    if (st.claudeActive && st.activity === 'needs-attention') input++
    for (const r of [{ git: st.git, ci: st.ci, e2e: st.e2e }, ...st.extraRepos]) {
      e2eFailed += r.e2e?.filter((run) => run.state === 'failed').length ?? 0
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
    { n: e2eFailed, text: 'e2e failed', tone: 'tone-red' },
    { n: changes, text: 'changes requested', tone: 'tone-red' },
    { n: building, text: 'building', tone: 'tone-orange' },
    { n: waiting, text: 'awaiting review', tone: 'tone-orange' },
    { n: ready, text: 'ready to merge', tone: 'tone-green' },
    { n: approved - ready, text: 'approved', tone: 'tone-green' }
  ]
    .filter((c) => c.n > 0)
    .map((c) => ({ text: `${c.n} ${c.text}`, tone: c.tone }))
}

/** ⌘E window: every tab at a glance — activity + elapsed, context %, and per
 *  repo the branch with its Jira status, PR review, CI (with progress) and
 *  local git counts, plus a one-line "doing" snippet. Click a card to go; click
 *  a chip to open the ticket, PR or build. */
export function MissionControl({
  tabs,
  statuses,
  colors,
  activeId,
  onSelectTab
}: Props): React.JSX.Element {
  const now = useNow()
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
  const [asked, setAsked] = useState<Record<TabId, string>>({})
  const prevActivity = useRef<Record<TabId, ActivityState>>({})
  useEffect(() => {
    for (const tab of tabs) {
      const activity = statuses[tab.tabId]?.activity ?? 'starting'
      const known = tab.tabId in prevActivity.current
      const prev = prevActivity.current[tab.tabId]
      prevActivity.current[tab.tabId] = activity
      // a new prompt starts a turn, so the "asked" line moves on any change
      if (!known || prev !== activity) {
        void window.claudeTerm.missionAsk(tab.tabId).then((text) => {
          if (text) setAsked((d) => ({ ...d, [tab.tabId]: text }))
        })
      }
      if (!known || (prev === 'busy' && activity !== 'busy')) {
        void window.claudeTerm.missionDoing(tab.tabId).then((text) => {
          if (text) setDoing((d) => ({ ...d, [tab.tabId]: text }))
        })
      }
    }
  }, [tabs, statuses])

  return (
    <div className="mission-window">
      <div className="mission-panel">
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
          <button
            className="range-btn mission-board-link"
            title="Open work across Jira, Bitbucket and GitHub"
            onClick={() => window.claudeTerm.toggleBoard()}
          >
            Work board
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
                <span className={reviewVerdict(r).tone}>{reviewVerdict(r).label}</span>
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
                onClick={() => onSelectTab(tab.tabId)}
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
                    e2e={st.e2e}
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
                      e2e={r.e2e}
                      behindThreshold={settings.behindThreshold}
                    />
                  ))}
                {asked[tab.tabId] && (
                  <div className="mission-asked" title={asked[tab.tabId]}>
                    <span className="mission-label">asked</span>
                    {asked[tab.tabId]}
                  </div>
                )}
                {doing[tab.tabId] && (
                  <div className="mission-doing">
                    <span className="mission-label">latest</span>
                    {doing[tab.tabId]}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
