import { describe, expect, it } from 'vitest'
import type { BoardPr, TabStatus, WorkItem } from '../../shared/types'
import { boardDigest, MAX_DIGEST } from './board-digest'

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

const item = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id: key,
  context: 'mendrix',
  kind: 'ticket',
  title: 'Fix the thing',
  url: `https://jira/${key}`,
  ticket: {
    key,
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
  warning: null,
  plan: null,
  ...over
})

describe('boardDigest', () => {
  it('keeps what needs you, most pressing first, with the reasons', () => {
    const digest = boardDigest(
      [
        item('MTX-1', { prs: [pr({ review: 'approved' })] }),
        item('MTX-2'),
        item('MTX-3', {
          prs: [pr({ number: 7, ci: { state: 'failed', url: '', name: 'DevBuild #2' } })]
        })
      ],
      []
    )
    expect(digest.map((d) => d.id)).toEqual(['MTX-3', 'MTX-1'])
    expect(digest[0]).toMatchObject({
      title: 'MTX-3 Fix the thing',
      reasons: ['PR #7: DevBuild #2 failed', 'PR is open, ticket still Active'],
      url: 'https://jira/MTX-3',
      tabId: null
    })
    expect(digest[1].reasons[0]).toBe('PR #5: approved, ready to merge')
    const [keyed] = boardDigest([item('MTX-5', { title: '[MTX-5] Fix it', warning: 'odd' })], [])
    expect(keyed.title).toBe('[MTX-5] Fix it')
  })

  it('names the session that waits on a prompt, and stays a briefing', () => {
    const waiting = {
      tabId: 't9',
      claudeActive: true,
      activity: 'needs-attention',
      git: { branch: 'bugfix/MTX-4-x', pr: null },
      extraRepos: []
    } as unknown as TabStatus
    const [first] = boardDigest([item('MTX-4')], [waiting])
    expect(first).toMatchObject({ tabId: 't9', reasons: ['its session is waiting on a prompt'] })
    const many = Array.from({ length: 12 }, (_, i) =>
      item(`MTX-${i + 10}`, { prs: [pr({ review: 'changes' })] })
    )
    expect(boardDigest(many, [])).toHaveLength(MAX_DIGEST)
  })
})
