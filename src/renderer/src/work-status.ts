import type { BranchPr, CiInfo, TicketStatus } from '../../shared/types'

/** Labels and colour classes for PR review, CI and Jira status — shared by the
 *  status bar and Mission Control. */

export function prReviewLabel(pr: BranchPr): string {
  if (pr.draft) return 'draft'
  if (pr.review === 'approved') return pr.approvals > 1 ? `approved ×${pr.approvals}` : 'approved'
  if (pr.review === 'changes') return 'changes requested'
  return 'awaiting review'
}

/** `tone-*` class: pending → blue, approved → green, changes → orange. */
export function prTone(pr: BranchPr): string {
  if (pr.draft) return 'tone-dim'
  return pr.review === 'approved'
    ? 'tone-green'
    : pr.review === 'changes'
      ? 'tone-orange'
      : 'tone-blue'
}

export function ciLabel(ci: CiInfo): string {
  if (ci.state === 'running') return ci.progress != null ? `running ${ci.progress}%` : 'running'
  return ci.state === 'success' ? 'passed' : ci.state
}

export function ciTone(ci: CiInfo): string {
  return ci.state === 'success'
    ? 'tone-green'
    : ci.state === 'failed'
      ? 'tone-red'
      : ci.state === 'running'
        ? 'tone-orange'
        : 'tone-dim'
}

/** Board stages read by name first (MendriX: Active → Peer review → Deploy →
 *  Done), falling back on Jira's category for anything else. */
export function ticketTone(t: TicketStatus): string {
  const name = t.status.toLowerCase()
  if (t.category === 'done') return 'tone-green'
  if (/block|hold|impediment/.test(name)) return 'tone-red'
  if (/review/.test(name)) return 'tone-magenta'
  if (/deplo|test|accept|release|merge/.test(name)) return 'tone-cyan'
  if (t.category === 'todo') return 'tone-dim'
  return 'tone-blue'
}
