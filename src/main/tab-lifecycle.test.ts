import { describe, expect, it } from 'vitest'
import { disposeAll, disposeTab, type TabResources } from './tab-lifecycle'

/** Records what was released, in the order it happened. */
function spy(): { r: TabResources; calls: string[] } {
  const calls: string[] = []
  const note =
    (what: string) =>
    (tabId: string): void => {
      calls.push(`${what}:${tabId}`)
    }
  return {
    calls,
    r: {
      closeDocs: async (tabId) => {
        calls.push(`closeDocs:${tabId}`)
      },
      killPty: note('killPty'),
      releaseParked: note('releaseParked'),
      forgetQueued: note('forgetQueued'),
      forgetNotices: note('forgetNotices'),
      unregister: note('unregister'),
      forgetCheckpoints: note('forgetCheckpoints')
    }
  }
}

describe('disposeTab', () => {
  it('releases everything the tab holds', async () => {
    const { r, calls } = spy()
    await disposeTab('t1', r)
    expect(calls).toEqual([
      'closeDocs:t1',
      'killPty:t1',
      'releaseParked:t1',
      'forgetQueued:t1',
      'forgetNotices:t1',
      'unregister:t1',
      'forgetCheckpoints:t1'
    ])
  })

  // The detached windows resolve their cwd/roots through the tab's status, and
  // they may prompt to save — both need the tab still registered.
  it('closes the detached windows before unregistering the tab', async () => {
    const { r, calls } = spy()
    await disposeTab('t1', r)
    expect(calls.indexOf('closeDocs:t1')).toBeLessThan(calls.indexOf('unregister:t1'))
  })
})

/**
 * The regression. A renderer reload left the previous load's tabs registered in
 * the main process with their PTYs alive, so the restore that followed spawned a
 * SECOND `claude --resume` on the same conversation. On a companion phone the
 * abandoned tab showed up as a ghost session row, and a prompt sent to that row
 * went into the abandoned PTY — lost, as far as the sender could tell.
 */
describe('disposeAll', () => {
  it('kills the PTY of every tab it drops', async () => {
    const { r, calls } = spy()
    const dropped = await disposeAll(['ghost', 'live'], r)
    expect(dropped).toBe(2)
    expect(calls.filter((c) => c.startsWith('killPty'))).toEqual(['killPty:ghost', 'killPty:live'])
    expect(calls.filter((c) => c.startsWith('unregister'))).toEqual([
      'unregister:ghost',
      'unregister:live'
    ])
  })

  it('is a no-op for a main process holding nothing', async () => {
    const { r, calls } = spy()
    expect(await disposeAll([], r)).toBe(0)
    expect(calls).toEqual([])
  })
})
