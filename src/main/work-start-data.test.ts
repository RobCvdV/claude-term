import { describe, expect, it } from 'vitest'
import type { BoardPr, BranchHistoryEntry, WorkContext, WorkItem } from '../shared/types'
import {
  cardPrompt,
  lastBranchIn,
  resumePrompt,
  startsFor,
  type LocalRepo
} from './work-start-data'

const contexts: WorkContext[] = [
  {
    id: 'mendrix',
    name: 'MendriX',
    jira: { excludeStatuses: [] },
    bitbucketWorkspaces: ['mendrix', 'mendrixmobile'],
    github: false
  }
]

const repo = (root: string, owner: string, name: string, host = 'bitbucket'): LocalRepo => ({
  root,
  ref: { host: host as 'bitbucket' | 'github', owner, repo: name }
})

const repos = [
  repo('/dev/tms', 'mendrix', 'mendrix-tms'),
  repo('/dev/tms-2', 'mendrix', 'mendrix-tms'),
  repo('/dev/next', 'mendrixmobile', 'mendrix-mobile-next'),
  repo('/dev/term', 'robcvdv', 'claude-term', 'github')
]

const pr = (over: Partial<BoardPr> = {}): BoardPr => ({
  url: 'https://bitbucket.org/mendrix/mendrix-tms/pull-requests/5',
  number: 5,
  title: 'PR',
  review: 'pending',
  approvals: 0,
  draft: false,
  comments: null,
  repo: 'mendrix/mendrix-tms',
  branch: 'bugfix/MTX-1-x',
  ci: null,
  ...over
})

const ticket = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'MTX-1',
  context: 'mendrix',
  kind: 'ticket',
  title: 'Fix the thing',
  url: 'https://mendrix.atlassian.net/browse/MTX-1',
  ticket: {
    key: 'MTX-1',
    status: 'To Do',
    category: 'todo',
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
  warning: null,
  ...over
})

const used = (root: string, branch: string, lastUsed = 1): BranchHistoryEntry => ({
  root,
  branch,
  lastUsed
})

describe('startsFor', () => {
  it('prefers the clone the ticket branch was used in', () => {
    const starts = startsFor(
      ticket({ prs: [pr()] }),
      repos,
      [used('/dev/tms-2', 'bugfix/MTX-1-x')],
      contexts
    )
    expect(starts[0]).toEqual({ root: '/dev/tms-2', branch: 'bugfix/MTX-1-x', sure: true })
    expect(starts[1]).toEqual({ root: '/dev/tms', branch: 'bugfix/MTX-1-x', sure: false })
  })

  it('asks which clone when the PR repo has several and none had the branch', () => {
    const starts = startsFor(ticket({ prs: [pr()] }), repos, [], contexts)
    expect(starts.map((s) => [s.root, s.sure])).toEqual([
      ['/dev/tms', false],
      ['/dev/tms-2', false]
    ])
  })

  it('a ticket without branch or PR offers the clones its labels point at', () => {
    const labelled = ticket({ ticket: { ...ticket().ticket!, labels: ['DriverAPI'] } })
    expect(startsFor(labelled, repos, [used('/dev/tms-2', 'x', 5)], contexts)).toEqual([
      { root: '/dev/tms-2', branch: null, sure: false },
      { root: '/dev/tms', branch: null, sure: false }
    ])
  })

  it('without matching labels, the workspace clones used before', () => {
    const history = [used('/dev/next', 'feature/MTX-9-y', 5), used('/dev/tms', 'x', 2)]
    expect(startsFor(ticket(), repos, history, contexts).map((s) => s.root)).toEqual([
      '/dev/next',
      '/dev/tms'
    ])
    expect(startsFor(ticket(), repos, [], contexts)).toHaveLength(3)
  })

  it('a single clone of an issue repo is started without asking', () => {
    const issue = ticket({
      kind: 'issue',
      ticket: null,
      context: 'personal',
      url: 'https://github.com/RobCvdV/claude-term/issues/3'
    })
    expect(startsFor(issue, repos, [], contexts)).toEqual([
      { root: '/dev/term', branch: null, sure: true }
    ])
  })
})

describe('cardPrompt', () => {
  it('adds failing builds and requested changes to the ticket prompt', () => {
    const item = ticket({
      prs: [
        pr({ review: 'changes', ci: { state: 'failed', url: 'https://ci/1', name: 'Jenkins' } })
      ]
    })
    const text = cardPrompt(item, 'Start on MTX-1.')
    expect(text).toContain('Start on MTX-1.\n\nAlso:\n- The Jenkins build of')
    expect(text).toContain('(https://ci/1): find out why.')
    expect(text).toContain('Reviewers requested changes on')
  })

  it('asks a review session not to post anything', () => {
    const review = ticket({ kind: 'review', ticket: null, url: 'https://github.com/a/b/pull/1' })
    expect(cardPrompt(review, null)).toMatch(
      /^Review https:\/\/github.com\/a\/b\/pull\/1 .*don't post/
    )
  })
})

describe('resumePrompt', () => {
  it('only says what is new, or nothing', () => {
    expect(resumePrompt(ticket({ prs: [pr()] }))).toBe('')
    expect(resumePrompt(ticket({ prs: [pr({ review: 'changes' })] }))).toMatch(
      /^I'm back on this\.\nReviewers requested changes on /
    )
  })
})

describe('lastBranchIn', () => {
  it('reads the newest record, also from a tail cut mid-line', () => {
    const tail =
      'ch":"bugfix/old"}\n{"gitBranch":"bugfix/MTX-1-x","cwd":"/r"}\n{"gitBranch":"feature/a\\"b"}\n'
    expect(lastBranchIn(tail)).toBe('feature/a\\"b')
    expect(lastBranchIn('{"type":"summary"}')).toBe(null)
  })
})
