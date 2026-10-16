import { describe, expect, it } from 'vitest'
import type { BranchPr, CiInfo, CiState, GitInfo, TabStatus } from '../shared/types'
import { WorkWatch, type WorkEvent } from './work-watch'

const pr = (p: Partial<BranchPr> = {}): BranchPr => ({
  url: 'u',
  number: 5,
  title: 't',
  review: 'pending',
  approvals: 0,
  draft: false,
  comments: 0,
  ...p
})
const git = (g: Partial<GitInfo> = {}): GitInfo => ({
  branch: 'bugfix/MTX-1-x',
  changed: 0,
  unpushed: 0,
  behind: 0,
  remoteUrl: 'git@bitbucket.org:a/b.git',
  prUrl: null,
  pr: null,
  mergedPr: null,
  ticket: null,
  hasWorkflows: false,
  ...g
})
const ci = (state: CiState): CiInfo => ({ provider: 'circleci', state, url: '' })
const tab = (g: GitInfo, c: CiInfo | null = null, tabId = 't1'): TabStatus =>
  ({ tabId, git: g, ci: c, extraRepos: [] }) as unknown as TabStatus

function watcher(movedByUs = false): { watch: WorkWatch; events: WorkEvent[] } {
  const events: WorkEvent[] = []
  return {
    watch: new WorkWatch(
      (e) => events.push(e),
      () => 20,
      () => movedByUs
    ),
    events
  }
}
const kinds = (events: WorkEvent[]): string[] => events.map((e) => e.kind)

describe('WorkWatch', () => {
  it('takes the first look as a baseline', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), ci('failed')))
    expect(events).toEqual([])
  })

  it('reports review verdicts and new comments on the same PR', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git({ pr: pr() })))
    watch.observe(tab(git({ pr: pr({ review: 'changes', comments: 2 }) })))
    expect(kinds(events)).toEqual(['prChanges', 'prComments'])
    expect(events[1].title).toBe('2 new comments on PR #5')
  })

  it('treats a newly opened PR as a baseline', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git()))
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) })))
    expect(events).toEqual([])
  })

  it('reports ready to merge once', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git({ pr: pr() }), ci('success')))
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), ci('success')))
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), ci('success')))
    expect(kinds(events)).toEqual(['readyToMerge'])
    expect(events[0]).toMatchObject({
      alsoKind: 'prApproved',
      title: 'PR #5 approved — ready to merge'
    })
  })

  it('reports ready to merge on its own when the build turns green', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), ci('running')))
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), ci('success')))
    expect(kinds(events)).toEqual(['readyToMerge'])
  })

  it('reports a failed build, and green again only after a failure', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git(), ci('success')))
    watch.observe(tab(git(), ci('running')))
    watch.observe(tab(git(), ci('success')))
    expect(events).toEqual([])
    watch.observe(tab(git(), ci('running')))
    watch.observe(tab(git(), ci('failed')))
    watch.observe(tab(git(), null)) // a dropped poll
    watch.observe(tab(git(), ci('running')))
    watch.observe(tab(git(), ci('success')))
    expect(kinds(events)).toEqual(['ciFailed', 'ciFixed'])
  })

  it('reports ticket moves, except our own', () => {
    const t = (status: string): GitInfo['ticket'] => ({
      key: 'MTX-1',
      status,
      category: 'progress',
      summary: '',
      assignee: null
    })
    const a = watcher()
    a.watch.observe(tab(git({ ticket: t('Peer review') })))
    a.watch.observe(tab(git({ ticket: t('Deploy') })))
    expect(a.events[0]).toMatchObject({ kind: 'ticketMoved', title: 'MTX-1 moved to Deploy' })
    const b = watcher(true)
    b.watch.observe(tab(git({ ticket: t('Active') })))
    b.watch.observe(tab(git({ ticket: t('Peer review') })))
    expect(b.events).toEqual([])
  })

  it('raises one event for tabs sharing a branch', () => {
    const { watch, events } = watcher()
    watch.observe(tab(git({ pr: pr() }), null, 't1'))
    watch.observe(tab(git({ pr: pr() }), null, 't2'))
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), null, 't1'))
    watch.observe(tab(git({ pr: pr({ review: 'approved' }) }), null, 't2'))
    expect(events).toHaveLength(1)
  })
})
