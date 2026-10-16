import type { BranchPr, CiInfo, GitInfo, TicketStatus } from '../../shared/types'
import { ticketStage, type TicketStage } from '../../shared/work-rules'

/** Labels and colour classes for PR review, CI and Jira status — shared by the
 *  status bar and Mission Control. */

export function prReviewLabel(pr: BranchPr): string {
  if (pr.draft) return 'draft'
  if (pr.review === 'approved') return pr.approvals > 1 ? `approved ×${pr.approvals}` : 'approved'
  if (pr.review === 'changes') return 'changes requested'
  return 'awaiting review'
}

/** `tone-*` class: not reviewed → orange, approved → green, changes → red
 *  (merged → blue and no PR → grey are the branch's, see branchPrTone). */
export function prTone(pr: BranchPr): string {
  if (pr.draft) return 'tone-dim'
  return pr.review === 'approved'
    ? 'tone-green'
    : pr.review === 'changes'
      ? 'tone-red'
      : 'tone-orange'
}

/** The branch's PR dot: its open PR's review, else blue when merged, else grey. */
export function branchPrTone(git: GitInfo): string {
  if (git.pr) return prTone(git.pr)
  return git.mergedPr ? 'tone-blue' : 'tone-dim'
}

export function branchPrLabel(git: GitInfo): string {
  if (git.pr) return `#${git.pr.number} ${prReviewLabel(git.pr)}`
  return git.mergedPr ? `#${git.mergedPr.number} merged` : 'no PR for this branch'
}

export function ciLabel(ci: CiInfo): string {
  if (ci.state === 'running') return ci.progress != null ? `running ${ci.progress}%` : 'running'
  if (ci.state === 'held') return 'on hold'
  return ci.state === 'success' ? 'passed' : ci.state
}

export function ciTone(ci: CiInfo): string {
  return ci.state === 'success'
    ? 'tone-green'
    : ci.state === 'failed'
      ? 'tone-red'
      : ci.state === 'running' || ci.state === 'held'
        ? 'tone-orange'
        : 'tone-dim'
}

const STAGE_TONES: Record<TicketStage, string> = {
  todo: 'tone-dim',
  active: 'tone-blue',
  review: 'tone-magenta',
  deploy: 'tone-cyan',
  done: 'tone-green',
  blocked: 'tone-red'
}

export function ticketTone(t: TicketStatus): string {
  return STAGE_TONES[ticketStage(t)]
}
