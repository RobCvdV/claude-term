import { describe, expect, it } from 'vitest'
import {
  adfText,
  basicAuth,
  buildWorklogBody,
  sinceDateFor,
  startedAt0900,
  toBookedWorklogs
} from './jira-helpers'
import type { JiraWorklogRaw } from './jira-helpers'

describe('basicAuth', () => {
  it('encodes email:token', () => {
    expect(basicAuth('a@b.nl', 'tok')).toBe('Basic ' + Buffer.from('a@b.nl:tok').toString('base64'))
  })
})

describe('startedAt0900', () => {
  it('is 09:00 local on the given day with a colon-less offset', () => {
    expect(startedAt0900('2026-08-06')).toMatch(/^2026-08-06T09:00:00\.000[+-]\d{4}$/)
  })
  it('round-trips to the same local date and hour', () => {
    const d = new Date(startedAt0900('2026-01-15'))
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(15)
    expect(d.getHours()).toBe(9)
  })
})

describe('buildWorklogBody', () => {
  it('converts hours to seconds and puts the activity in an ADF paragraph', () => {
    const body = buildWorklogBody({
      date: '2026-08-06',
      issueKey: 'MTX-1',
      hours: 2.5,
      activity: 'coding'
    }) as { timeSpentSeconds: number; comment: unknown; started: string }
    expect(body.timeSpentSeconds).toBe(9000)
    expect(adfText(body.comment)).toBe('coding')
    expect(body.started.startsWith('2026-08-06T09:00')).toBe(true)
  })
})

describe('toBookedWorklogs', () => {
  const raw = (over: Partial<JiraWorklogRaw>): JiraWorklogRaw => ({
    id: '1',
    author: { accountId: 'me' },
    started: '2026-08-06T10:00:00.000+0200',
    timeSpentSeconds: 3600,
    ...over
  })

  it('keeps my worklogs on/after the since date', () => {
    const out = toBookedWorklogs('MTX-1', [raw({})], 'me', '2026-08-01')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ issueKey: 'MTX-1', hours: 1, worklogId: '1' })
  })

  it('drops other authors, old dates, and malformed entries', () => {
    const out = toBookedWorklogs(
      'MTX-1',
      [
        raw({ author: { accountId: 'someone-else' } }),
        raw({ started: '2026-07-01T10:00:00.000+0200' }),
        raw({ started: undefined }),
        raw({ timeSpentSeconds: undefined })
      ],
      'me',
      '2026-08-01'
    )
    expect(out).toHaveLength(0)
  })

  it('extracts the ADF comment text', () => {
    const comment = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'reviewing' }] }]
    }
    const out = toBookedWorklogs('MTX-1', [raw({ comment })], 'me', '2026-08-01')
    expect(out[0].comment).toBe('reviewing')
  })
})

describe('sinceDateFor', () => {
  it('rangeDays=1 is today', () => {
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    expect(sinceDateFor(1)).toBe(`${y}-${m}-${d}`)
  })
  it('windows extend backwards', () => {
    expect(sinceDateFor(7) < sinceDateFor(1)).toBe(true)
  })
})
