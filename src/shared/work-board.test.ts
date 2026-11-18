import { describe, expect, it } from 'vitest'
import type { BoardPr, GitInfo, TabStatus, WorkItem } from './types'
import { laneOf, matchesFilter, sessionFor } from './work-board'

const pr = (over: Partial<BoardPr> = {}): BoardPr => ({
  url: 'https://bitbucket.org/ws/repo/pull-requests/5',
  number: 5,
  title: 'PR',
  review: 'pending',
  approvals: 0,
  draft: false,
  comments: null,
  repo: 'ws/repo',
  branch: 'bugfix/MTX-1-x',
  ci: null,
  ...over
})

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'MTX-1',
  context: 'mendrix',
  kind: 'ticket',
  title: 'Fix the thing',
  url: '',
  ticket: {
    key: 'MTX-1',
    status: 'Active',
    category: 'progress',
    summary: '',
    assignee: null,
    type: 'Bug',
    labels: []
  },
  prs: [],
  review: null,
  updated: 0,
  starts: [],
  handedOff: null,
  ...over
})

const git = (branch: string, prUrl?: string): GitInfo => ({
  branch,
  changed: 0,
  unpushed: 0,
  behind: 0,
  remoteUrl: '',
  prUrl: prUrl ?? null,
  pr: prUrl ? { ...pr(), url: prUrl } : null,
  mergedPr: null,
  ticket: null,
  hasWorkflows: false
})

const session = (branch: string, over: Partial<TabStatus> = {}): TabStatus =>
  ({
    tabId: 't1',
    claudeActive: true,
    activity: 'idle',
    git: git(branch),
    extraRepos: [],
    ...over
  }) as TabStatus

describe('laneOf', () => {
  it('puts red builds, requested changes and approved PRs on you', () => {
    expect(laneOf(item({ prs: [pr({ ci: { state: 'failed', url: '', name: '' } })] }), null)).toBe(
      'needs-you'
    )
    expect(laneOf(item({ prs: [pr({ review: 'changes' })] }), null)).toBe('needs-you')
    expect(laneOf(item({ prs: [pr({ review: 'approved' })] }), null)).toBe('needs-you')
  })

  it('waits on reviewers, running builds and later board stages', () => {
    expect(laneOf(item({ prs: [pr()] }), null)).toBe('waiting')
    const review = { ...item().ticket!, status: 'Peer review' }
    expect(laneOf(item({ ticket: review }), null)).toBe('waiting')
  })

  it('reads active tickets, drafts and open sessions as in progress, the rest as to do', () => {
    expect(laneOf(item(), null)).toBe('in-progress')
    expect(laneOf(item({ prs: [pr({ draft: true })] }), null)).toBe('in-progress')
    const todo = { ...item().ticket!, status: 'To Do', category: 'todo' as const }
    expect(laneOf(item({ ticket: todo }), null)).toBe('todo')
    expect(laneOf(item({ ticket: todo }), session('bugfix/MTX-1-x'))).toBe('in-progress')
  })

  it('a session waiting for input, or an unanswered review, needs you', () => {
    expect(laneOf(item(), session('x', { activity: 'needs-attention' }))).toBe('needs-you')
    const review = { repo: 'a/b', number: 1, title: '', url: 'u', author: '', myVerdict: null }
    expect(laneOf(item({ kind: 'review', ticket: null, review }), null)).toBe('needs-you')
    expect(
      laneOf(
        item({ kind: 'review', ticket: null, review: { ...review, myVerdict: 'approved' } }),
        null
      )
    ).toBe('waiting')
  })
})

describe('matchesFilter', () => {
  it('needs every word somewhere on the card', () => {
    const it_ = item({ prs: [pr()] })
    expect(matchesFilter(it_, 'mtx-1 thing')).toBe(true)
    expect(matchesFilter(it_, 'ws/repo active')).toBe(true)
    expect(matchesFilter(it_, 'thing deploy')).toBe(false)
    expect(matchesFilter(it_, '  ')).toBe(true)
  })
})

describe('sessionFor', () => {
  it('matches the exact ticket key in a branch, or the PR url', () => {
    expect(sessionFor(item(), [session('bugfix/MTX-1-x')])?.tabId).toBe('t1')
    expect(sessionFor(item(), [session('bugfix/MTX-11-x')])).toBe(null)
    const byPr = { ...session('main'), git: git('main', pr().url) }
    expect(sessionFor(item({ ticket: null, prs: [pr()] }), [byPr])?.tabId).toBe('t1')
  })
})
