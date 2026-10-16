import { describe, expect, it } from 'vitest'
import type { BranchPr, CiInfo, GitInfo, TicketStatus } from './types'
import { readyToMerge, ticketDrift, ticketStage, tooFarBehind } from './work-rules'

const pr = (p: Partial<BranchPr> = {}): BranchPr => ({
  url: 'u',
  number: 5,
  title: 't',
  review: 'approved',
  approvals: 1,
  draft: false,
  comments: 0,
  ...p
})
const ticket = (status: string, category: TicketStatus['category'] = 'progress'): TicketStatus => ({
  key: 'MTX-1',
  status,
  category,
  summary: '',
  assignee: null
})
const git = (g: Partial<GitInfo> = {}): GitInfo => ({
  branch: 'bugfix/MTX-1-x',
  changed: 0,
  unpushed: 0,
  behind: 0,
  remoteUrl: '',
  prUrl: null,
  pr: null,
  mergedPr: null,
  ticket: null,
  hasWorkflows: false,
  ...g
})
const green: CiInfo = { provider: 'circleci', state: 'success', url: '' }

describe('ticketStage', () => {
  it('reads the MendriX board names', () => {
    expect(ticketStage(ticket('Active'))).toBe('active')
    expect(ticketStage(ticket('Peer review'))).toBe('review')
    expect(ticketStage(ticket('Deploy'))).toBe('deploy')
    expect(ticketStage(ticket('Done', 'done'))).toBe('done')
    expect(ticketStage(ticket('To Do', 'todo'))).toBe('todo')
    expect(ticketStage(ticket('On hold'))).toBe('blocked')
  })
})

describe('readyToMerge', () => {
  it('needs approval, green CI and a clean, current branch', () => {
    expect(readyToMerge(git({ pr: pr() }), green, 20)).toBe(true)
    expect(readyToMerge(git({ pr: pr() }), null, 20)).toBe(true)
    expect(readyToMerge(git({ pr: pr({ review: 'pending' }) }), green, 20)).toBe(false)
    expect(readyToMerge(git({ pr: pr({ draft: true }) }), green, 20)).toBe(false)
    expect(readyToMerge(git({ pr: pr() }), { ...green, state: 'running' }, 20)).toBe(false)
    expect(readyToMerge(git({ pr: pr(), unpushed: 1 }), green, 20)).toBe(false)
    expect(readyToMerge(git({ pr: pr(), behind: 20 }), green, 20)).toBe(false)
  })

  it('flags an open PR far behind main', () => {
    expect(tooFarBehind(git({ pr: pr(), behind: 25 }), 20)).toBe(true)
    expect(tooFarBehind(git({ behind: 25 }), 20)).toBe(false)
  })
})

describe('ticketDrift', () => {
  it('spots a ticket lagging its PR', () => {
    expect(ticketDrift(git({ pr: pr(), ticket: ticket('Active') }))).toMatchObject({
      moveTo: 'review'
    })
    expect(ticketDrift(git({ pr: pr(), ticket: ticket('Peer review') }))).toBeNull()
  })

  it('spots a merged PR whose ticket did not move on', () => {
    const merged = { number: 9, url: 'm' }
    expect(ticketDrift(git({ mergedPr: merged, ticket: ticket('Peer review') }))).toMatchObject({
      moveTo: 'deploy'
    })
    expect(ticketDrift(git({ mergedPr: merged, ticket: ticket('Deploy') }))).toBeNull()
  })

  it('spots a done ticket whose branch is still out', () => {
    expect(ticketDrift(git({ ticket: ticket('Done', 'done') }))?.moveTo).toBeUndefined()
    expect(ticketDrift(git({ branch: 'main', ticket: ticket('Done', 'done') }))).toBeNull()
  })
})
