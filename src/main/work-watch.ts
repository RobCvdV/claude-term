import type {
  CiInfo,
  CiState,
  E2eRun,
  E2eState,
  GitInfo,
  NotifyEvent,
  PrReview,
  TabId,
  TabStatus
} from '../shared/types'
import { readyToMerge } from '../shared/work-rules'

/** What changed on a branch since the last look, as notification text. */
export interface WorkEvent {
  kind: NotifyEvent
  /** also shown when only this kind is switched on (one notification for two changes) */
  alsoKind?: NotifyEvent
  /** repo + branch, for dedupe */
  key: string
  title: string
  body: string
  tabId: TabId
}

/** The parts of a branch's state a change notification is about. */
export interface RepoSnap {
  prNumber: number | null
  review: PrReview | null
  comments: number | null
  ci: CiState | null
  /** the last finished build (success / failed), carried across a running one */
  settled: CiState | null
  ticket: string | null
  ready: boolean
  /** each e2e test group's state */
  e2e: Record<string, E2eState>
}

export function snapOf(
  git: GitInfo,
  ci: CiInfo | null,
  behindThreshold: number,
  e2e: E2eRun[] = []
): RepoSnap {
  return {
    e2e: Object.fromEntries(e2e.map((r) => [r.group, r.state])),
    prNumber: git.pr?.number ?? null,
    review: git.pr && !git.pr.draft ? git.pr.review : null,
    comments: git.pr?.comments ?? null,
    ci: ci && ci.state !== 'unknown' ? ci.state : null,
    settled: ci?.state === 'success' || ci?.state === 'failed' ? ci.state : null,
    ticket: git.ticket?.status ?? null,
    ready: readyToMerge(git, ci, behindThreshold)
  }
}

type Change = Pick<WorkEvent, 'kind' | 'alsoKind' | 'title' | 'body'>

/** Changes between two looks at one branch. A PR that appears or is replaced
 *  is a new baseline — opening it yourself is no news. */
export function diffSnaps(
  prev: RepoSnap,
  next: RepoSnap,
  ctx: { branch: string; ticketKey: string | null; ticketMovedByUs: boolean }
): Change[] {
  const out: Change[] = []
  const where = ctx.branch
  const samePr = prev.prNumber !== null && prev.prNumber === next.prNumber
  if (samePr) {
    const pr = `PR #${next.prNumber}`
    const approved = next.review !== prev.review && next.review === 'approved'
    const ready = next.ready && !prev.ready
    if (approved && ready) {
      out.push({
        kind: 'readyToMerge',
        alsoKind: 'prApproved',
        title: `${pr} approved — ready to merge`,
        body: where
      })
    } else if (approved) {
      out.push({ kind: 'prApproved', title: `${pr} approved`, body: where })
    }
    if (next.review !== prev.review && next.review === 'changes') {
      out.push({ kind: 'prChanges', title: `Changes requested on ${pr}`, body: where })
    }
    if (prev.comments !== null && next.comments !== null && next.comments > prev.comments) {
      const n = next.comments - prev.comments
      out.push({
        kind: 'prComments',
        title: `${n} new comment${n === 1 ? '' : 's'} on ${pr}`,
        body: where
      })
    }
    if (ready && !approved) {
      out.push({ kind: 'readyToMerge', title: `${pr} is ready to merge`, body: where })
    }
  }
  // CI is only compared between two known states — a dropped poll is not news
  if (prev.ci && next.ci && prev.ci !== next.ci) {
    if (next.ci === 'failed') out.push({ kind: 'ciFailed', title: 'Build failed', body: where })
    if (next.ci === 'success' && prev.settled === 'failed') {
      out.push({ kind: 'ciFixed', title: 'Build green again', body: where })
    }
  }
  // a group seen going that failed — not one that had failed before we looked
  const broke = Object.entries(next.e2e)
    .filter(([g, s]) => s === 'failed' && prev.e2e[g] && prev.e2e[g] !== 'failed')
    .map(([g]) => g)
  if (broke.length) {
    out.push({ kind: 'e2eFailed', title: `E2E failed: ${broke.join(', ')}`, body: where })
  }
  if (prev.ticket && next.ticket && prev.ticket !== next.ticket && !ctx.ticketMovedByUs) {
    out.push({
      kind: 'ticketMoved',
      title: `${ctx.ticketKey ?? 'Ticket'} moved to ${next.ticket}`,
      body: `from ${prev.ticket} — ${where}`
    })
  }
  return out
}

/**
 * Watches every tab's branches for review, CI and ticket changes. Keyed by
 * remote + branch, so tabs sharing a branch raise one notification. The first
 * look at a branch only sets its baseline.
 */
export class WorkWatch {
  private seen = new Map<string, RepoSnap>()

  constructor(
    private readonly emit: (e: WorkEvent) => void,
    private readonly behindThreshold: () => number,
    private readonly movedByUs: (ticketKey: string) => boolean
  ) {}

  observe(status: TabStatus): void {
    const repos: { git: GitInfo | null; ci: CiInfo | null; e2e?: E2eRun[] }[] = [
      { git: status.git, ci: status.ci, e2e: status.e2e },
      ...status.extraRepos
    ]
    for (const { git, ci, e2e } of repos) {
      if (!git?.branch || !git.remoteUrl) continue
      const key = `${git.remoteUrl}#${git.branch}`
      const next = snapOf(git, ci, this.behindThreshold(), e2e)
      const prev = this.seen.get(key)
      // keep the last known CI / ticket through a poll that came back empty
      if (prev) {
        next.ci ??= prev.ci
        next.settled ??= prev.settled
        next.ticket ??= prev.ticket
        // a poll that came back empty keeps the groups we knew
        if (!Object.keys(next.e2e).length) next.e2e = prev.e2e
      }
      this.seen.set(key, next)
      if (!prev) continue
      const ticketKey = git.ticket?.key ?? null
      for (const change of diffSnaps(prev, next, {
        branch: git.branch,
        ticketKey,
        ticketMovedByUs: !!ticketKey && this.movedByUs(ticketKey)
      })) {
        this.emit({ ...change, key, tabId: status.tabId })
      }
    }
  }
}
