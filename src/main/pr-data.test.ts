import { describe, expect, it } from 'vitest'
import {
  accountIdFromCommits,
  bitbucketBranchPr,
  githubBranchPr,
  mapBitbucketPrs,
  mapGithubPrs,
  MAX_PRS
} from './pr-data'

const ghRow = (
  n: number,
  login = 'someone'
): { number: number; title: string; url: string; author: { login: string } } => ({
  number: n,
  title: `feat: change ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  author: { login }
})

describe('mapGithubPrs', () => {
  it('maps gh output and carries the repo merge capability', () => {
    expect(mapGithubPrs(JSON.stringify([ghRow(39), ghRow(38)]), true)).toEqual([
      {
        number: 39,
        title: 'feat: change 39',
        url: 'https://github.com/o/r/pull/39',
        canMerge: true,
        mine: false
      },
      {
        number: 38,
        title: 'feat: change 38',
        url: 'https://github.com/o/r/pull/38',
        canMerge: true,
        mine: false
      }
    ])
  })

  it('marks the PRs the signed-in user opened', () => {
    const json = JSON.stringify([ghRow(2, 'rob'), ghRow(1, 'colleague')])
    expect(mapGithubPrs(json, false, 'rob').map((p) => [p.number, p.mine])).toEqual([
      [2, true],
      [1, false]
    ])
  })

  it('claims nothing when we do not know who is signed in', () => {
    // an unmarked PR is a small loss; marking someone else's as yours is not
    const json = JSON.stringify([ghRow(2, 'rob')])
    expect(mapGithubPrs(json, false).every((p) => p.mine)).toBe(false)
    expect(mapGithubPrs(json, false, null).every((p) => p.mine)).toBe(false)
    expect(mapGithubPrs(json, false, '').every((p) => p.mine)).toBe(false)
  })

  it('drops malformed rows and caps at MAX_PRS', () => {
    const rows = [...Array.from({ length: 15 }, (_, i) => ghRow(i + 1)), { title: 'no number' }]
    const prs = mapGithubPrs(JSON.stringify(rows), false)
    expect(prs).toHaveLength(MAX_PRS)
    expect(prs.every((p) => !p.canMerge)).toBe(true)
  })

  it('survives a row with no author at all', () => {
    const json = JSON.stringify([{ number: 5, title: 'x', url: 'https://h/5' }])
    expect(mapGithubPrs(json, false, 'rob')[0].mine).toBe(false)
  })
})

describe('mapBitbucketPrs', () => {
  const bbRow = (id: number, accountId?: string): Record<string, unknown> => ({
    id,
    title: `MTX-${id} fix`,
    links: { html: { href: `https://bitbucket.org/o/r/pull-requests/${id}` } },
    ...(accountId ? { author: { account_id: accountId } } : {})
  })

  it('maps the API listing and never offers merge', () => {
    const body = { values: [bbRow(7), { id: 8, title: 'broken row, no link' }] }
    expect(mapBitbucketPrs(body)).toEqual([
      {
        number: 7,
        title: 'MTX-7 fix',
        url: 'https://bitbucket.org/o/r/pull-requests/7',
        canMerge: false,
        mine: false
      }
    ])
  })

  it('marks mine by account id — display names are not identity', () => {
    const body = { values: [bbRow(7, 'me-id'), bbRow(8, 'them-id')] }
    expect(mapBitbucketPrs(body, 'me-id').map((p) => [p.number, p.mine])).toEqual([
      [7, true],
      [8, false]
    ])
    expect(mapBitbucketPrs(body).every((p) => p.mine)).toBe(false)
  })

  it('tolerates an empty/malformed body', () => {
    expect(mapBitbucketPrs({})).toEqual([])
  })
})

describe('accountIdFromCommits', () => {
  const commit = (raw: string, accountId?: string): Record<string, unknown> => ({
    author: { raw, ...(accountId ? { user: { account_id: accountId } } : {}) }
  })

  it('takes the account of the first linked commit with our email', () => {
    const body = {
      values: [
        commit('Someone <other@x.nl>', 'other-id'),
        commit('Rob <R.Coenen@mendrix.nl>'),
        commit('Rob C <r.coenen@mendrix.nl>', 'me-id')
      ]
    }
    expect(accountIdFromCommits(body, 'r.coenen@mendrix.nl')).toBe('me-id')
  })

  it('does not match an email that merely contains ours', () => {
    const body = { values: [commit('X <xr.coenen@mendrix.nl>', 'x-id')] }
    expect(accountIdFromCommits(body, 'r.coenen@mendrix.nl')).toBeNull()
    expect(accountIdFromCommits({}, 'r.coenen@mendrix.nl')).toBeNull()
  })
})

describe('githubBranchPr', () => {
  const row = (extra: object): string =>
    JSON.stringify([{ url: 'https://x/pull/7', number: 7, title: 'T', isDraft: false, ...extra }])

  it('uses reviewDecision when the repo requires reviews', () => {
    expect(
      githubBranchPr(row({ reviewDecision: 'APPROVED', latestReviews: [{ state: 'APPROVED' }] }))
    ).toMatchObject({ review: 'approved', approvals: 1 })
    expect(githubBranchPr(row({ reviewDecision: 'CHANGES_REQUESTED' }))?.review).toBe('changes')
    expect(githubBranchPr(row({ reviewDecision: 'REVIEW_REQUIRED' }))?.review).toBe('pending')
  })

  it('falls back on the latest reviews without required reviews', () => {
    const reviews = (...s: string[]): object => ({
      reviewDecision: '',
      latestReviews: s.map((state) => ({ state }))
    })
    expect(githubBranchPr(row(reviews()))?.review).toBe('pending')
    expect(githubBranchPr(row(reviews('APPROVED')))?.review).toBe('approved')
    expect(githubBranchPr(row(reviews('APPROVED', 'CHANGES_REQUESTED')))?.review).toBe('changes')
  })

  it('is null without a PR', () => {
    expect(githubBranchPr('[]')).toBeNull()
  })
})

describe('bitbucketBranchPr', () => {
  const body = (participants: object[]): unknown => ({
    values: [
      {
        id: 280,
        title: 'T',
        draft: false,
        comment_count: 7,
        links: { html: { href: 'https://bb/pr/280' } },
        participants
      }
    ]
  })

  it('reads approvals and requested changes from the participants', () => {
    expect(bitbucketBranchPr(body([{ approved: false, state: null }]))).toMatchObject({
      number: 280,
      review: 'pending',
      comments: 7
    })
    expect(
      bitbucketBranchPr(body([{ approved: true, state: 'approved' }, { approved: true }]))
    ).toMatchObject({ review: 'approved', approvals: 2 })
    expect(
      bitbucketBranchPr(body([{ approved: true }, { state: 'changes_requested' }]))?.review
    ).toBe('changes')
  })

  it('is null without a PR', () => {
    expect(bitbucketBranchPr({ values: [] })).toBeNull()
  })
})
