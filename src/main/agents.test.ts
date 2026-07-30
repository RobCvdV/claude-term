import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findBgJobForSession } from './agents'

let jobs: string

/** A job record shaped like a real ~/.claude/jobs/<jobId>/state.json. The job
 *  dir is the short job id (the first 8 chars of the agent's OWN session id),
 *  and linkScanPath names the session it was forked from. */
function job(opts: {
  sessionId: string
  state: string
  /** the parent it resumed/forked from — defaults to itself, as for an agent
   *  that was backgrounded from the start */
  resumeSessionId?: string
}): void {
  const parent = opts.resumeSessionId ?? opts.sessionId
  const dir = join(jobs, opts.sessionId.slice(0, 8))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      sessionId: opts.sessionId,
      resumeSessionId: parent,
      linkScanPath: `/Users/x/.claude/projects/-proj/${parent}.jsonl`,
      state: opts.state,
      template: 'bg'
    })
  )
}

beforeEach(() => {
  jobs = mkdtempSync(join(tmpdir(), 'ct-jobs-'))
})
afterEach(() => {
  rmSync(jobs, { recursive: true, force: true })
})

describe('findBgJobForSession', () => {
  it('finds the job for a session running as a background agent', () => {
    job({ sessionId: 'fef93e1b-e0da-408c-b36e-98331abbd7c7', state: 'blocked' })
    expect(findBgJobForSession('fef93e1b-e0da-408c-b36e-98331abbd7c7', jobs)).toEqual({
      jobId: 'fef93e1b',
      state: 'blocked'
    })
  })

  it('returns null for a session with no job record', () => {
    job({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', state: 'done' })
    expect(findBgJobForSession('bbbbbbbb-0000-0000-0000-000000000000', jobs)).toBeNull()
  })

  it('returns null when there is no jobs directory at all', () => {
    expect(
      findBgJobForSession('aaaaaaaa-0000-0000-0000-000000000000', join(jobs, 'nope'))
    ).toBeNull()
  })

  it('skips unreadable records and keeps looking', () => {
    mkdirSync(join(jobs, 'garbage'), { recursive: true })
    writeFileSync(join(jobs, 'garbage', 'state.json'), 'not json')
    mkdirSync(join(jobs, 'empty'), { recursive: true })
    job({ sessionId: 'cccccccc-0000-0000-0000-000000000000', state: 'working' })
    expect(findBgJobForSession('cccccccc-0000-0000-0000-000000000000', jobs)?.jobId).toBe(
      'cccccccc'
    )
  })

  // The regression. A tab session that dispatched a background agent is that
  // agent's `resumeSessionId`, which is what linkScanPath names — so matching on
  // linkScanPath returned the SUB-AGENT's job for the tab's own session. The
  // real pair from this machine: job bdd0ac82 forked from tab session 7f55dc88.
  it('does not mistake a sub-agent for the parent session that dispatched it', () => {
    const parent = '7f55dc88-72f2-4616-aa8a-9e85ee8e36d8'
    job({
      sessionId: 'bdd0ac82-332f-4934-afa7-6135412def61',
      resumeSessionId: parent,
      state: 'blocked'
    })
    // the parent is an ordinary conversation — it must resume, not attach
    expect(findBgJobForSession(parent, jobs)).toBeNull()
    // the sub-agent itself is still found by its own id
    expect(findBgJobForSession('bdd0ac82-332f-4934-afa7-6135412def61', jobs)?.jobId).toBe(
      'bdd0ac82'
    )
  })
})
