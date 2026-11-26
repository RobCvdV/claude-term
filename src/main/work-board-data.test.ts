import { describe, expect, it } from 'vitest'
import type { ReviewItem, WorkContext } from '../shared/types'
import {
  excludedStatus,
  joinWork,
  mapBitbucketMyPrs,
  mapGithubWork,
  mapMyJiraIssues,
  type SourcePr
} from './work-board-data'
import { bitbucketStatusesCi } from './ci-data'

const contexts: WorkContext[] = [
  {
    id: 'mendrix',
    name: 'MendriX',
    jira: { excludeStatuses: ['Deploy', 'Beta', 'Done'] },
    bitbucketWorkspaces: ['mendrix', 'mendrixmobile'],
    github: false
  },
  { id: 'personal', name: 'Personal', jira: null, bitbucketWorkspaces: [], github: true }
]

const issue = (
  key: string,
  status: string,
  cat = 'indeterminate',
  updated = '2026-11-10T10:00:00Z'
): object => ({
  key,
  fields: {
    summary: `${key} summary`,
    status: { name: status, statusCategory: { key: cat } },
    issuetype: { name: 'Bug' },
    updated
  }
})

const bbPr = (id: number, branch: string, over: object = {}): object => ({
  id,
  title: `PR ${id}`,
  links: { html: { href: `https://bitbucket.org/mendrixmobile/next/pull-requests/${id}` } },
  participants: [],
  source: { branch: { name: branch }, commit: { hash: `h${id}` } },
  destination: { repository: { full_name: 'mendrixmobile/next' } },
  updated_on: '2026-11-12T10:00:00Z',
  ...over
})

describe('mapMyJiraIssues / excludedStatus', () => {
  it('maps issues with type and update time', () => {
    const [t] = mapMyJiraIssues({ issues: [issue('MTX-1', 'Active')] })
    expect(t).toMatchObject({ key: 'MTX-1', status: 'Active', category: 'progress', type: 'Bug' })
    expect(t.updated).toBe(Date.parse('2026-11-10T10:00:00Z'))
  })

  it('excludes by status prefix, case-insensitively', () => {
    expect(excludedStatus('Beta (mobile)', ['Beta'])).toBe(true)
    expect(excludedStatus('deploy', ['Deploy'])).toBe(true)
    expect(excludedStatus('Peer review', ['Deploy', 'Beta'])).toBe(false)
  })
})

describe('mapBitbucketMyPrs', () => {
  it('keeps repo, branch and head commit with the review state', () => {
    const [src] = mapBitbucketMyPrs(
      { values: [bbPr(5, 'bugfix/MTX-1-x', { participants: [{ state: 'changes_requested' }] })] },
      'mendrixmobile'
    )
    expect(src).toMatchObject({ host: 'bitbucket', owner: 'mendrixmobile', hash: 'h5' })
    expect(src.pr).toMatchObject({
      repo: 'mendrixmobile/next',
      branch: 'bugfix/MTX-1-x',
      review: 'changes'
    })
  })
})

describe('mapGithubWork', () => {
  it('reads PRs with review decision and checks, and assigned issues', () => {
    const { prs, issues } = mapGithubWork({
      data: {
        prs: {
          nodes: [
            {
              number: 7,
              title: 'feat: x',
              url: 'https://github.com/me/app/pull/7',
              reviewDecision: 'APPROVED',
              headRefName: 'feature/x',
              updatedAt: '2026-11-11T00:00:00Z',
              repository: { nameWithOwner: 'me/app' },
              comments: { totalCount: 2 },
              latestReviews: { nodes: [{ state: 'APPROVED' }] },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }
            }
          ]
        },
        issues: {
          nodes: [
            {
              number: 3,
              title: 'bug',
              url: 'https://github.com/me/app/issues/3',
              repository: { nameWithOwner: 'me/app' }
            }
          ]
        }
      }
    })
    expect(prs[0].pr).toMatchObject({ review: 'approved', comments: 2, repo: 'me/app' })
    expect(prs[0].pr.ci).toMatchObject({
      state: 'failed',
      url: 'https://github.com/me/app/pull/7/checks'
    })
    expect(issues).toEqual([
      {
        repo: 'me/app',
        number: 3,
        title: 'bug',
        url: 'https://github.com/me/app/issues/3',
        updated: 0
      }
    ])
  })
})

describe('bitbucketStatusesCi', () => {
  it('lets a failure win, then a running build, then a stopped one, then success', () => {
    const s = (state: string, name = state): object => ({ state, name, url: `u/${name}` })
    expect(bitbucketStatusesCi({ values: [s('SUCCESSFUL'), s('FAILED')] })).toMatchObject({
      state: 'failed',
      url: 'u/FAILED'
    })
    expect(bitbucketStatusesCi({ values: [s('SUCCESSFUL'), s('INPROGRESS')] })?.state).toBe(
      'running'
    )
    expect(bitbucketStatusesCi({ values: [s('SUCCESSFUL'), s('STOPPED')] })).toMatchObject({
      state: 'stopped',
      url: 'u/STOPPED'
    })
    expect(bitbucketStatusesCi({ values: [s('STOPPED'), s('FAILED')] })?.state).toBe('failed')
    expect(bitbucketStatusesCi({ values: [s('SUCCESSFUL')] })?.state).toBe('success')
    expect(bitbucketStatusesCi({ values: [] })).toBe(null)
  })
})

describe('joinWork', () => {
  const tickets = mapMyJiraIssues({
    issues: [issue('MTX-1', 'Active'), issue('MTX-2', 'Deploy'), issue('MTX-3', 'Beta (mobile)')]
  })
  const prs: SourcePr[] = [
    ...mapBitbucketMyPrs(
      { values: [bbPr(5, 'bugfix/MTX-1-x'), bbPr(6, 'bugfix/MTX-2-y')] },
      'mendrixmobile'
    ),
    ...mapGithubWork({
      data: {
        prs: {
          nodes: [
            {
              number: 7,
              title: 'feat',
              url: 'https://github.com/me/app/pull/7',
              repository: { nameWithOwner: 'me/app' }
            }
          ]
        }
      }
    }).prs
  ]
  const review: ReviewItem = {
    repo: 'mendrix/tms',
    number: 9,
    title: 'review me',
    url: 'https://bitbucket.org/mendrix/tms/pull-requests/9',
    author: 'Ann',
    myVerdict: null
  }

  const items = joinWork({ contexts, tickets, prs, issues: [], reviews: [review] })
  const byId = Object.fromEntries(items.map((i) => [i.id, i]))

  it('hangs a PR on the ticket its branch names', () => {
    expect(byId['MTX-1'].prs.map((p) => p.number)).toEqual([5])
    expect(byId['MTX-1'].context).toBe('mendrix')
  })

  it('leaves excluded tickets off, but keeps their still-open PRs as cards', () => {
    expect(byId['MTX-2']).toBeUndefined()
    expect(byId['MTX-3']).toBeUndefined()
    const pr6 = items.find((i) => i.prs[0]?.number === 6)
    expect(pr6).toMatchObject({ kind: 'pr', context: 'mendrix', ticket: { key: 'MTX-2' } })
    expect(pr6?.warning).toMatch(/^MTX-2 is already in Deploy, but this PR isn't merged/)
    expect(byId['MTX-1'].warning).toBe(null)
  })

  it('puts GitHub PRs in the GitHub context and reviews by their host', () => {
    expect(byId['https://github.com/me/app/pull/7']).toMatchObject({
      kind: 'pr',
      context: 'personal'
    })
    expect(byId[`review:${review.url}`]).toMatchObject({ kind: 'review', context: 'mendrix' })
  })

  it('drops what no context claims', () => {
    const noGithub = joinWork({
      contexts: [contexts[0]],
      tickets: [],
      prs,
      issues: [],
      reviews: []
    })
    expect(noGithub.some((i) => i.url.includes('github.com'))).toBe(false)
  })
})
