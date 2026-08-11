import { describe, expect, it } from 'vitest'
import { StatusServer } from './status-server'
import type { StatuslinePayload, TabStatus } from '../shared/types'

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

/** Drive a statusline the way an HTTP POST to /statusline does. */
const statusline = (server: StatusServer, tabId: string, payload: StatuslinePayload): void =>
  (
    server as unknown as { handleStatusline: (t: string, p: StatuslinePayload) => void }
  ).handleStatusline(tabId, payload)

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
  // The regression: the tab's cwd is its identity (persisted, respawned), and
  // NO payload field is safe to adopt. current_dir follows the Bash tool's
  // persistent cwd, and even project_dir moves mid-session (/cd + set_cwd
  // relocate the session and rewrite originalCwd; a resumed session chdirs
  // back to its recorded home by itself). Adopting either drifted the tab
  // into another repo and corrupted the restore.
  describe('statusline workspace', () => {
    it('ignores current_dir drift (mid-session cd into another repo)', () => {
      const { server, tabId } = withLiveTab()
      statusline(server, tabId, {
        session_id: 'sess-1',
        workspace: { current_dir: '/other-repo', project_dir: '/repo' }
      })
      expect(server.getCwd(tabId)).toBe('/repo')
      expect(server.snapshot(tabId)?.cwd).toBe('/repo')
    })

    it('ignores the top-level cwd field too (same drifting value)', () => {
      const { server, tabId } = withLiveTab()
      statusline(server, tabId, { session_id: 'sess-1', cwd: '/other-repo' })
      expect(server.getCwd(tabId)).toBe('/repo')
    })

    it('ignores a project_dir move too (/cd, or a resumed session going home)', () => {
      const { server, tabId } = withLiveTab()
      statusline(server, tabId, {
        session_id: 'sess-1',
        workspace: { current_dir: '/elsewhere', project_dir: '/elsewhere' }
      })
      expect(server.getCwd(tabId)).toBe('/repo')
      expect(server.snapshot(tabId)?.cwd).toBe('/repo')
    })

    it('still records the session id and payload', () => {
      const { server, tabId } = withLiveTab()
      statusline(server, tabId, {
        session_id: 'sess-2',
        workspace: { current_dir: '/other-repo', project_dir: '/repo' }
      })
      const s = server.snapshot(tabId)
      expect(s?.sessionId).toBe('sess-2')
      expect(s?.payload?.workspace?.current_dir).toBe('/other-repo')
    })
  })

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

describe('firstRemoteUrl (real git)', () => {
  it('prefers origin, falls back to any-named remote, null with none', async () => {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { execFileSync } = await import('child_process')
    const { firstRemoteUrl } = await import('./status-server')

    const base = mkdtempSync(join(tmpdir(), 'ct-remote-'))
    const make = (name: string, remotes: [string, string][]): string => {
      const dir = join(base, name)
      execFileSync('git', ['init', '-q', dir])
      for (const [rname, url] of remotes) {
        execFileSync('git', ['-C', dir, 'remote', 'add', rname, url])
      }
      return dir
    }

    const withOrigin = make('a', [
      ['BitBucket', 'git@bitbucket.org:x/other.git'],
      ['origin', 'git@bitbucket.org:x/a.git']
    ])
    const namedOnly = make('b', [['BitBucket', 'git@bitbucket.org:x/b.git']])
    const bare = make('c', [])

    expect(await firstRemoteUrl(withOrigin)).toBe('git@bitbucket.org:x/a.git')
    expect(await firstRemoteUrl(namedOnly)).toBe('git@bitbucket.org:x/b.git')
    expect(await firstRemoteUrl(bare)).toBeNull()
  })
})

describe('stale-tab routing (attached agents after an app restart)', () => {
  const route = (server: StatusServer, tabId: string, sessionId?: string): string =>
    (server as unknown as { resolveTab: (t: string, s?: string) => string }).resolveTab(
      tabId,
      sessionId
    )

  it('re-routes an unknown tab id to the tab hosting that session', () => {
    const { server, tabId } = withLiveTab()
    expect(route(server, 'stale-tab-from-old-run', 'sess-1')).toBe(tabId)
  })

  it('keeps known tab ids and unknown sessions as-is', () => {
    const { server, tabId } = withLiveTab()
    expect(route(server, tabId, 'sess-1')).toBe(tabId)
    expect(route(server, 'stale-tab', 'sess-nobody')).toBe('stale-tab')
    expect(route(server, 'stale-tab')).toBe('stale-tab')
  })
})

describe('attached-agent synthetic activity', () => {
  const poll = (server: StatusServer): void =>
    (server as unknown as { pollAttached: () => void }).pollAttached()
  const feedOf = (
    server: StatusServer,
    tabId: string
  ): { transcriptPath: string | null; live: boolean } =>
    (
      server as unknown as {
        attached: Map<string, { transcriptPath: string | null; live: boolean }>
      }
    ).attached.get(tabId)!

  it('derives busy from a fresh transcript write and idle from silence', async () => {
    const { mkdtempSync, writeFileSync, utimesSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { server, updates, tabId } = withLiveTab()
    server.markAttached(tabId, 'sess-1', null)
    const transcript = join(mkdtempSync(join(tmpdir(), 'ct-attach-')), 'sess-1.jsonl')
    writeFileSync(transcript, '{}\n')
    feedOf(server, tabId).transcriptPath = transcript

    poll(server)
    expect(server.snapshot(tabId)?.activity).toBe('busy')
    expect(updates.at(-1)?.busySince).not.toBeNull()

    const old = (Date.now() - 60_000) / 1000
    utimesSync(transcript, old, old)
    poll(server)
    expect(server.snapshot(tabId)?.activity).toBe('idle')
  })

  it('stands down once a real feed reaches the tab', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { server, tabId } = withLiveTab()
    server.markAttached(tabId, 'sess-1', null)
    const transcript = join(mkdtempSync(join(tmpdir(), 'ct-attach2-')), 'sess-1.jsonl')
    writeFileSync(transcript, '{}\n')
    feedOf(server, tabId).transcriptPath = transcript

    hook(server, tabId, 'UserPromptSubmit')
    expect(feedOf(server, tabId).live).toBe(true)
    hook(server, tabId, 'Stop')
    poll(server) // fresh transcript would say busy — but the live feed said idle
    expect(server.snapshot(tabId)?.activity).toBe('idle')
  })
})

describe('endpoint persistence', () => {
  it('keeps port and token across restarts; falls back when the port is taken', async () => {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const file = join(mkdtempSync(join(tmpdir(), 'ct-endpoint-')), 'status-endpoint.json')

    const first = new StatusServer(() => file)
    await first.start()
    const { port, token } = first
    expect(port).toBeGreaterThan(0)
    first.stop()
    // same file → same endpoint on the next run
    const second = new StatusServer(() => file)
    await second.start()
    expect(second.port).toBe(port)
    expect(second.token).toBe(token)
    // port already held by `second` → a third instance falls back to a new one
    const third = new StatusServer(() => file)
    await third.start()
    expect(third.port).not.toBe(port)
    expect(third.port).toBeGreaterThan(0)
    second.stop()
    third.stop()
  })
})
