import type { CiInfo, GitInfo, TicketStatus } from './types'
import { isTrunkBranch } from './repo-links'

/** Where a ticket sits on the board. Read by name first (MendriX: Active →
 *  Peer review → Deploy → Done), Jira's category for anything else. */
export type TicketStage = 'todo' | 'active' | 'review' | 'deploy' | 'done' | 'blocked'

export function ticketStage(t: TicketStatus): TicketStage {
  const name = t.status.toLowerCase()
  if (t.category === 'done') return 'done'
  if (/block|hold|impediment/.test(name)) return 'blocked'
  if (/review/.test(name)) return 'review'
  if (/deplo|test|accept|release|merge/.test(name)) return 'deploy'
  if (t.category === 'todo') return 'todo'
  return 'active'
}

/** Approved, not a draft, build green (or no CI, or only an approval step
 *  left), nothing local left over and not too far behind main. */
export function readyToMerge(git: GitInfo, ci: CiInfo | null, behindThreshold: number): boolean {
  const pr = git.pr
  if (!pr || pr.draft || pr.review !== 'approved') return false
  if (ci && ci.state !== 'success' && ci.state !== 'held') return false
  return git.changed === 0 && git.unpushed === 0 && git.behind < behindThreshold
}

/** An open PR far enough behind main to want a rebase before review. */
export function tooFarBehind(git: GitInfo, behindThreshold: number): boolean {
  return !!git.pr && git.behind >= behindThreshold
}

export interface Drift {
  text: string
  /** the board stage a one-click fix moves the ticket to */
  moveTo?: 'review' | 'deploy'
}

/** The ticket's board state lagging what the branch shows. */
export function ticketDrift(git: GitInfo): Drift | null {
  const t = git.ticket
  if (!t) return null
  const stage = ticketStage(t)
  if (git.pr && (stage === 'todo' || stage === 'active')) {
    return { text: `PR is open, ticket still ${t.status}`, moveTo: 'review' }
  }
  if (!git.pr && git.mergedPr && (stage === 'todo' || stage === 'active' || stage === 'review')) {
    return { text: `PR #${git.mergedPr.number} merged, ticket still ${t.status}`, moveTo: 'deploy' }
  }
  if (stage === 'done' && !isTrunkBranch(git.branch)) {
    return { text: `ticket is ${t.status}, branch still checked out` }
  }
  return null
}
