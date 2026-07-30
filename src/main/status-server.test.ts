import { describe, expect, it } from 'vitest'
import { StatusServer } from './status-server'
import type { TabStatus } from '../shared/types'

/** A server with a registered tab hosting a live Claude session, plus the
 *  updates it pushed. No HTTP listener: the hook/statusline entry points are
 *  driven straight through the private handlers, as the real requests do. */
function withLiveTab(): { server: StatusServer; updates: TabStatus[]; tabId: string } {
  const server = new StatusServer()
  const updates: TabStatus[] = []
  server.onUpdate = (s) => updates.push({ ...s })
  const tabId = 'tab-1'
  server.registerTab(tabId, '/repo')
  server.markClaudeActive(tabId, 'sess-1')
  updates.length = 0
  return { server, updates, tabId }
}

/** What the renderer would persist for the tab right now. */
const persisted = (server: StatusServer, tabId: string): [boolean, string | null] => {
  const s = server.snapshot(tabId)
  return [!!s?.claudeActive, s?.sessionId ?? null]
}

/** Drive a hook the way an HTTP POST to /hook does. */
const hook = (server: StatusServer, tabId: string, name: string): void =>
  (
    server as unknown as { handleHook: (t: string, e: { hook_event_name: string }) => void }
  ).handleHook(tabId, { hook_event_name: name })

describe('StatusServer', () => {
  it('tracks a live session', () => {
    const { server, tabId } = withLiveTab()
    expect(persisted(server, tabId)).toEqual([true, 'sess-1'])
  })

  it('clears the session when it ends while running', () => {
    const { server, tabId } = withLiveTab()
    hook(server, tabId, 'SessionEnd')
    expect(persisted(server, tabId)).toEqual([false, 'sess-1'])
  })

  // The regression. Quitting kills every PTY, and each dying session reports
  // itself gone — via the PTY exit and its own SessionEnd hook. Those updates
  // used to reach the renderer before its final save, so a tab mid-conversation
  // persisted as "no session was running" and the next launch revived nothing.
  describe('freeze', () => {
    it('keeps a live session live when the PTY is killed on quit', () => {
      const { server, tabId } = withLiveTab()
      server.freeze()
      server.markExited(tabId, 0)
      expect(persisted(server, tabId)).toEqual([true, 'sess-1'])
    })

    it('ignores the SessionEnd the session fires on its way out', () => {
      const { server, tabId } = withLiveTab()
      server.freeze()
      hook(server, tabId, 'SessionEnd')
      expect(persisted(server, tabId)).toEqual([true, 'sess-1'])
    })

    it('pushes no further updates to the renderer', () => {
      const { server, updates, tabId } = withLiveTab()
      server.freeze()
      server.markExited(tabId, 0)
      hook(server, tabId, 'SessionEnd')
      hook(server, tabId, 'Stop')
      server.markRestarted(tabId)
      server.markClaudeActive(tabId, 'sess-2')
      expect(updates).toEqual([])
    })

    it('still reports the live session to the quit dialog', () => {
      const { server } = withLiveTab()
      server.freeze()
      expect(server.activeClaudeCount()).toBe(1)
    })
  })
})
