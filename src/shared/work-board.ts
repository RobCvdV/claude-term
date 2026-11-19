import type { BoardKind, BoardLane, BoardPr, TabStatus, WorkItem } from './types'
import { ticketStage, type TicketStage } from './work-rules'
import { branchTicket } from './jira-labels'

export const BOARD_LANES: { id: BoardLane; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'todo', label: 'To do' }
]

export const BOARD_KINDS: { id: BoardKind; label: string }[] = [
  { id: 'ticket', label: 'Tickets' },
  { id: 'pr', label: 'PRs' },
  { id: 'review', label: 'Reviews' },
  { id: 'issue', label: 'Issues' }
]

/** Which column a card goes in: whose move it is, then how far along it is. */
export function laneOf(item: WorkItem, session: TabStatus | null): BoardLane {
  if (session?.claudeActive && session.activity === 'needs-attention') return 'needs-you'
  if (item.warning) return 'needs-you'
  if (item.review) return item.review.myVerdict ? 'waiting' : 'needs-you'
  const prs = item.prs
  if (prs.some((p) => p.review === 'changes' || p.ci?.state === 'failed')) return 'needs-you'
  // approved and not still building: merge it
  if (prs.some((p) => !p.draft && p.review === 'approved' && p.ci?.state !== 'running')) {
    return 'needs-you'
  }
  if (prs.some((p) => !p.draft || p.ci?.state === 'running')) return 'waiting'
  const stage = item.ticket ? ticketStage(item.ticket) : null
  if (stage === 'review' || stage === 'deploy' || stage === 'blocked') return 'waiting'
  if (session || prs.length > 0 || stage === 'active') return 'in-progress'
  return 'todo'
}

/** Approved, not a draft, build green (or none, or only an approval step left). */
export function mergeable(pr: BoardPr): boolean {
  if (pr.draft || pr.review !== 'approved') return false
  return !pr.ci || pr.ci.state === 'success' || pr.ci.state === 'held'
}

/** The ticket's board column lags its PRs: say so, and where it should go. */
export function boardDrift(
  item: WorkItem
): { text: string; moveTo: Extract<TicketStage, 'review' | 'deploy'> } | null {
  const t = item.ticket
  if (!t || item.warning) return null
  const stage = ticketStage(t)
  if ((stage === 'todo' || stage === 'active') && item.prs.some((p) => !p.draft)) {
    return { text: `PR is open, ticket still ${t.status}`, moveTo: 'review' }
  }
  if (stage === 'review' && item.kind === 'ticket' && item.prs.length === 0) {
    return { text: `no open PR left, ticket still ${t.status}`, moveTo: 'deploy' }
  }
  return null
}

/** Every word of the query appears in the card's key, title, status, repo or branch. */
export function matchesFilter(item: WorkItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [
    item.ticket?.key,
    item.ticket?.status,
    item.ticket?.type,
    item.title,
    item.review?.repo,
    item.review?.author,
    ...item.prs.flatMap((p) => [p.repo, p.branch, `#${p.number}`])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return words.every((w) => text.includes(w))
}

/** The open tab working on this item: its branch names the ticket, or its PR is one of the item's. */
export function sessionFor(item: WorkItem, sessions: readonly TabStatus[]): TabStatus | null {
  const key = item.ticket?.key
  const urls = new Set([...item.prs.map((p) => p.url), item.review?.url].filter(Boolean))
  return (
    sessions.find((st) =>
      [st.git, ...st.extraRepos.map((r) => r.git)].some(
        (git) =>
          !!git &&
          ((!!key && branchTicket(git.branch) === key) || (!!git.pr && urls.has(git.pr.url)))
      )
    ) ?? null
  )
}
