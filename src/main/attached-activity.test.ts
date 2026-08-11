import { describe, expect, it } from 'vitest'
import { attachedActivity, BUSY_WINDOW_MS } from './attached-activity'

const NOW = 1_700_000_000_000

describe('attachedActivity', () => {
  it('is busy while the transcript was written to recently', () => {
    expect(attachedActivity({ transcriptMtime: NOW - 2_000, jobState: 'running', now: NOW })).toBe(
      'busy'
    )
  })

  it('goes idle once the transcript is quiet', () => {
    expect(
      attachedActivity({ transcriptMtime: NOW - BUSY_WINDOW_MS - 1, jobState: 'done', now: NOW })
    ).toBe('idle')
  })

  it('a blocked job needs attention regardless of transcript freshness', () => {
    expect(attachedActivity({ transcriptMtime: NOW - 1_000, jobState: 'blocked', now: NOW })).toBe(
      'needs-attention'
    )
  })

  it('is idle with no transcript and no job state', () => {
    expect(attachedActivity({ transcriptMtime: null, jobState: null, now: NOW })).toBe('idle')
  })
})
