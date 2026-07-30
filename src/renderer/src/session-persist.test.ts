import { describe, expect, it } from 'vitest'
import type { TabStatus } from '../../shared/types'
import { persistedSessionOf, type RestoredSession } from './session-persist'

const status = (over: Partial<TabStatus>): TabStatus =>
  ({
    tabId: 't',
    claudeActive: false,
    activity: 'idle',
    busySince: null,
    sessionId: null,
    exitCode: null,
    cwd: '/x',
    payload: null,
    git: null,
    ...over
  }) as TabStatus

const live = (id: string): TabStatus => status({ sessionId: id, claudeActive: true })
/** Claude ran and the session ended — the id stays on the status. */
const ended = (id: string): TabStatus => status({ sessionId: id, claudeActive: false })
/** A restored tab that never got a session: revive downgraded to a shell. */
const bare = (): TabStatus => status({})

describe('persistedSessionOf', () => {
  it('persists a live session', () => {
    expect(persistedSessionOf(live('abc'), undefined)).toEqual({
      sessionId: 'abc',
      claudeActive: true
    })
  })

  it('persists a plain terminal as having no session', () => {
    expect(persistedSessionOf(bare(), undefined)).toEqual({
      sessionId: null,
      claudeActive: false
    })
  })

  it('keeps the restored session when the tab never hosted one this run', () => {
    const restored: RestoredSession = { sessionId: 'abc', claudeActive: true }
    expect(persistedSessionOf(bare(), restored)).toEqual(restored)
  })

  it('does not resurrect a session the user ended', () => {
    const restored: RestoredSession = { sessionId: 'abc', claudeActive: true }
    expect(persistedSessionOf(ended('abc'), restored)).toEqual({
      sessionId: 'abc',
      claudeActive: false
    })
  })

  it('prefers the tab’s own session over the restored one', () => {
    const restored: RestoredSession = { sessionId: 'old', claudeActive: true }
    expect(persistedSessionOf(live('new'), restored)).toEqual({
      sessionId: 'new',
      claudeActive: true
    })
  })

  // The failure this module exists for. A tab mid-conversation was persisted as
  // claudeActive:false during shutdown (the status server now freezes instead —
  // see StatusServer.freeze), so the next launch revived nothing; the tab then
  // overwrote its own session id with null and the launch after that had nothing
  // left to resume. Carrying the restored session forward makes that recoverable
  // even if a launch does fail to revive.
  it('survives a launch that failed to revive, so the next one can retry', () => {
    const persisted: RestoredSession = { sessionId: 'abc', claudeActive: true }
    // launch 1: revive didn't come up, tab is a bare shell
    const afterFailed = persistedSessionOf(bare(), persisted)
    expect(afterFailed).toEqual(persisted)
    // launch 2: same again — the id is still there to try
    expect(persistedSessionOf(bare(), afterFailed)).toEqual(persisted)
  })
})
