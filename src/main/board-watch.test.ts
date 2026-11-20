import { describe, expect, it } from 'vitest'
import type { BoardPr, TabStatus, WorkItem } from '../shared/types'
import type { Notice } from './desktop-notifier'
import { BoardWatch } from './board-watch'

const pr = (over: Partial<BoardPr> = {}): BoardPr => ({
  url: 'https://bitbucket.org/ws/app/pull-requests/5',
  number: 5,
  title: 'Fix it',
  review: 'pending',
  approvals: 0,
  draft: false,
  comments: 0,
  repo: 'ws/app',
  branch: 'bugfix/MTX-1-x',
  ci: { state: 'running', url: '', name: 'build' },
  ...over
})

const item = (prs: BoardPr[], status = 'Peer review', over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id: 'MTX-1',
    kind: 'ticket',
    title: 'Fix it',
    url: 'https://jira/MTX-1',
    ticket: { key: 'MTX-1', status, summary: 'Fix it', category: 'progress' },
    prs,
    review: null,
    handedOff: null,
    ...over
  }) as unknown as WorkItem

const tabOn = (branch: string): TabStatus =>
  ({ tabId: 't', git: { branch, pr: null }, extraRepos: [] }) as unknown as TabStatus

function watch(): { w: BoardWatch; shown: Notice[] } {
  const shown: Notice[] = []
  return {
    w: new BoardWatch(
      (n) => shown.push(n),
      () => false
    ),
    shown
  }
}

describe('BoardWatch', () => {
  it('first sight is a baseline; then a red build and requested changes notify', () => {
    const { w, shown } = watch()
    w.observe([item([pr()])], [])
    expect(shown).toEqual([])
    w.observe(
      [item([pr({ review: 'changes', ci: { state: 'failed', url: '', name: 'build' } })])],
      []
    )
    expect(shown.map((n) => n.kind)).toEqual(['prChanges', 'ciFailed'])
    expect(shown[0]).toMatchObject({ url: pr().url, body: 'app #5 — Fix it' })
  })

  it('a ticket moved by someone else notifies once, however many PRs it has', () => {
    const { w, shown } = watch()
    const two = [pr(), pr({ url: 'https://bitbucket.org/ws/app/pull-requests/6', number: 6 })]
    w.observe([item(two)], [])
    w.observe([item(two, 'Deploy')], [])
    expect(shown.map((n) => [n.kind, n.title])).toEqual([['ticketMoved', 'MTX-1 moved to Deploy']])
  })

  it('stays quiet for work a tab watches, and for handed-off PRs', () => {
    const { w, shown } = watch()
    w.observe([item([pr()])], [])
    const red = pr({ ci: { state: 'failed', url: '', name: 'build' } })
    w.observe([item([red])], [tabOn('bugfix/MTX-1-x')])
    w.observe([item([pr()], 'Peer review', { handedOff: 'Ann' })], [])
    expect(shown).toEqual([])
  })
})
