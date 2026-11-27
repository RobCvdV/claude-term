import { describe, expect, it } from 'vitest'
import type { BoardPr, TabStatus, WorkItem } from '../../shared/types'
import { boardDigest, boardItems, MAX_DIGEST } from './board-digest'

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

describe('boardItems', () => {
  it('lists every lane, with reasons only where it needs you', () => {
    const items = boardItems(
      [
        item('MTX-1', { prs: [pr({ ci: { state: 'failed', url: 'u', name: 'Build #9' } })] }),
        item('MTX-2', { starts: [{ root: '/src/app', branch: null, sure: true }] })
      ],
      []
    )
    expect(items.map((i) => [i.id, i.lane, i.startable])).toEqual([
      ['MTX-1', 'needs-you', false],
      ['MTX-2', 'in-progress', true]
    ])
    expect(items[0].reasons[0]).toBe('PR #5: Build #9 failed')
    expect(items[0].prs[0].ci).toEqual({ state: 'failed', name: 'Build #9' })
    expect(items[1].reasons).toEqual([])
    expect(items[1].title).toBe('MTX-2 Fix the thing')
  })
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
