import type {
  ActivityState,
  BranchPr,
  CiInfo,
  E2eRun,
  E2eState,
  GitInfo,
  ReviewItem,
  TabStatus,
  TicketStatus,
  WorkItem
} from '../../shared/types'
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

export function ciLabel(ci: Pick<CiInfo, 'state' | 'progress'>): string {
  if (ci.state === 'running') return ci.progress != null ? `running ${ci.progress}%` : 'running'
  if (ci.state === 'held') return 'on hold'
  return ci.state === 'success' ? 'passed' : ci.state
}

export function ciTone(ci: Pick<CiInfo, 'state'>): string {
  return ci.state === 'success'
    ? 'tone-green'
    : ci.state === 'failed'
      ? 'tone-red'
      : ci.state === 'running' || ci.state === 'held'
        ? 'tone-orange'
        : 'tone-dim'
}

/** The CI dot class an e2e state reads as. */
export function e2eDot(state: E2eState): string {
  const map: Record<E2eState, string> = {
    passed: 'ci-success',
    failed: 'ci-failed',
    running: 'ci-running',
    queued: 'ci-held',
    stopped: 'ci-unknown'
  }
  return map[state]
}

export function e2eTone(state: E2eState): string {
  return state === 'passed'
    ? 'tone-green'
    : state === 'failed'
      ? 'tone-red'
      : state === 'stopped'
        ? 'tone-dim'
        : 'tone-orange'
}

/** One group's line: what it is doing, or how its tests came out. */
export function e2eRunLabel(run: E2eRun): string {
  switch (run.state) {
    case 'queued':
      return 'queued'
    case 'running':
      return run.passed || run.failed ? `running · ${run.passed + run.failed} tests` : 'running'
    case 'stopped':
      return 'stopped'
    case 'failed':
      return `${run.failed} of ${run.passed + run.failed} failed`
    case 'passed':
      return `${run.passed} passed`
  }
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

export function dotFor(status: TabStatus | null | undefined): string {
  if (status?.activity === 'exited') return 'dot exited'
  if (!status?.claudeActive) return 'dot terminal'
  const map: Partial<Record<ActivityState, string>> = {
    busy: 'dot busy',
    'needs-attention': 'dot attention',
    idle: 'dot idle'
  }
  return map[status.activity] ?? 'dot idle'
}

export function activityLabel(status: TabStatus | null, now: number): string {
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

export const CI_NAMES: Record<CiInfo['provider'], string> = {
  jenkins: 'Jenkins',
  circleci: 'CircleCI',
  actions: 'Actions'
}

/** A chip inside a card that opens its link instead of selecting the card. */

export const moveTo = (key: string, stage: 'review' | 'deploy') => () =>
  window.claudeTerm.jiraMove(key, stage)

/** What I already said on a PR I was asked to review. */
export function reviewVerdict(r: ReviewItem): { label: string; tone: string } {
  if (r.myVerdict === 'approved') return { label: 'you approved', tone: 'tone-green' }
  if (r.myVerdict === 'changes') return { label: 'you asked for changes', tone: 'tone-orange' }
  return { label: 'to review', tone: 'tone-magenta' }
}

/** ▶ session's chip: what a click will do, and where. */
export function startChip(item: WorkItem): { label: string; title: string } {
  const plan = item.plan
  const folder = (root: string): string => root.split('/').pop() ?? root
  const right = ' — s (right-click or S: every clone, or a new worktree)'
  if (!plan) return { label: '▶ session', title: `Start or resume a Claude session${right}` }
  if (plan.kind === 'goto') {
    return { label: '→ tab', title: 'Go to the tab already on this branch — s' }
  }
  if (plan.kind === 'choose') {
    const why = plan.why ? `The usual clone is busy: ${plan.why}. ` : ''
    return { label: '▶ choose…', title: `${why}Pick a clone or a new worktree — s` }
  }
  const tab = plan.takeover ? ' · idle tab' : ''
  const where = `${folder(plan.root)}${plan.takeover ? ', in its idle tab' : ', in a new tab'}`
  return plan.kind === 'resume'
    ? {
        label: `↻ resume${tab}`,
        title: `Resume the branch's last conversation in ${where}${right}`
      }
    : { label: `▶ new${tab}`, title: `Start a Claude session about this card in ${where}${right}` }
}
