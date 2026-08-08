import { describe, expect, it } from 'vitest'
import { mapBitbucketPrs, mapGithubPrs, MAX_PRS } from './pr-data'

const ghRow = (n: number): { number: number; title: string; url: string } => ({
  number: n,
  title: `feat: change ${n}`,
  url: `https://github.com/o/r/pull/${n}`
})

describe('mapGithubPrs', () => {
  it('maps gh output and carries the repo merge capability', () => {
    expect(mapGithubPrs(JSON.stringify([ghRow(39), ghRow(38)]), true)).toEqual([
      {
        number: 39,
        title: 'feat: change 39',
        url: 'https://github.com/o/r/pull/39',
        canMerge: true
      },
      {
        number: 38,
        title: 'feat: change 38',
        url: 'https://github.com/o/r/pull/38',
        canMerge: true
      }
    ])
  })

  it('drops malformed rows and caps at MAX_PRS', () => {
    const rows = [...Array.from({ length: 15 }, (_, i) => ghRow(i + 1)), { title: 'no number' }]
    const prs = mapGithubPrs(JSON.stringify(rows), false)
    expect(prs).toHaveLength(MAX_PRS)
    expect(prs.every((p) => !p.canMerge)).toBe(true)
  })
})

describe('mapBitbucketPrs', () => {
  it('maps the API listing and never offers merge', () => {
    const body = {
      values: [
        {
          id: 7,
          title: 'MTX-1 fix',
          links: { html: { href: 'https://bitbucket.org/o/r/pull-requests/7' } }
        },
        { id: 8, title: 'broken row, no link' }
      ]
    }
    expect(mapBitbucketPrs(body)).toEqual([
      {
        number: 7,
        title: 'MTX-1 fix',
        url: 'https://bitbucket.org/o/r/pull-requests/7',
        canMerge: false
      }
    ])
  })

  it('tolerates an empty/malformed body', () => {
    expect(mapBitbucketPrs({})).toEqual([])
  })
})
