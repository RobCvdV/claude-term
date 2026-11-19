import type { BoardPr, TabStatus, WorkItem } from '../shared/types'
import { mergeable, sessionFor } from '../shared/work-board'
import { diffSnaps, type RepoSnap } from './work-watch'
import type { Notice } from './desktop-notifier'

const NO_PR: RepoSnap = {
  prNumber: null,
  review: null,
  comments: null,
  ci: null,
  settled: null,
  ticket: null,
  ready: false,
  e2e: {}
}

export function prSnap(pr: BoardPr): RepoSnap {
  const ci = pr.ci && pr.ci.state !== 'unknown' ? pr.ci.state : null
  return {
    ...NO_PR,
    prNumber: pr.number,
    review: pr.draft ? null : pr.review,
    comments: pr.comments,
    ci,
    settled: ci === 'success' || ci === 'failed' ? ci : null,
    ready: mergeable(pr)
  }
}

/**
 * Notifications for my open work that no tab watches: what changed on its PRs
 * and tickets between two sweeps. A tab's own work is notified by WorkWatch;
 * the first sight of a PR or ticket only sets its baseline.
 */
export class BoardWatch {
  private seen = new Map<string, RepoSnap>()

  constructor(
    private readonly emit: (n: Notice) => void,
    private readonly movedByUs: (ticketKey: string) => boolean
  ) {}

  observe(items: readonly WorkItem[], snapshots: readonly TabStatus[]): void {
    const next = new Map<string, RepoSnap>()
    for (const item of items) {
      if (item.kind === 'review' || item.handedOff) continue
      const quiet = !!sessionFor(item, snapshots)
      const looks: { key: string; snap: RepoSnap; where: string; url: string }[] = item.prs.map(
        (pr) => ({
          key: pr.url,
          snap: prSnap(pr),
          where: `${pr.repo.split('/').pop()} #${pr.number} — ${pr.title}`,
          url: pr.url
        })
      )
      if (item.ticket) {
        looks.push({
          key: `ticket:${item.ticket.key}`,
          snap: { ...NO_PR, ticket: item.ticket.status },
          where: item.ticket.summary || item.title,
          url: item.url
        })
      }
      for (const { key, snap, where, url } of looks) {
        const prev = this.seen.get(key)
        if (prev) {
          snap.ci ??= prev.ci
          snap.settled ??= prev.settled
        }
        next.set(key, snap)
        if (!prev || quiet) continue
        const ticketKey = item.ticket?.key ?? null
        for (const change of diffSnaps(prev, snap, {
          branch: where,
          ticketKey,
          ticketMovedByUs: !!ticketKey && this.movedByUs(ticketKey)
        })) {
          this.emit({ ...change, key, url })
        }
      }
    }
    this.seen = next
  }
}
