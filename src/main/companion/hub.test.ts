import { describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '../../shared/companion'
import type { TabStatus } from '../../shared/types'
import { CompanionHub, toSession } from './hub'
import { ParkedPrompts, type ParkedResponse } from './parked-prompts'
import type { CompanionServer } from './server'

function tabStatus(over: Partial<TabStatus> = {}): TabStatus {
  return {
    tabId: 't1',
    claudeActive: true,
    activity: 'busy',
    busySince: 1000,
    sessionId: 's1',
    exitCode: null,
    cwd: '/Users/rob/Dev/thing',
    addedDirs: [],
    removedDirs: [],
    payload: null,
    git: null,
    ci: null,
    extraRepos: [],
    ...over
  }
}

function fakeRes(): ParkedResponse {
  return {
    writableEnded: false,
    writeHead() {
      return this
    },
    end() {
      ;(this as { writableEnded: boolean }).writableEnded = true
    },
    on() {
      return this
    }
  }
}

/** A stand-in transport that records what would go out. */
function fakeServer(): CompanionServer & {
  sent: { deviceId: string; frame: ServerFrame }[]
  broadcasts: ServerFrame[]
  authed: number
} {
  const api = {
    authed: 1,
    sent: [] as { deviceId: string; frame: ServerFrame }[],
    broadcasts: [] as ServerFrame[],
    authenticatedCount() {
      return api.authed
    },
    broadcast(frame: ServerFrame) {
      api.broadcasts.push(frame)
    },
    sendTo(deviceId: string, frame: ServerFrame) {
      api.sent.push({ deviceId, frame })
    },
    onPresence: (() => {}) as (count: number) => void,
    onFrame: (() => {}) as (deviceId: string, frame: never) => void
  }
  return api as unknown as ReturnType<typeof fakeServer>
}

function setup(statuses: TabStatus[] = [tabStatus()]): {
  hub: CompanionHub
  server: ReturnType<typeof fakeServer>
  parked: ParkedPrompts
  injectPrompt: ReturnType<typeof vi.fn>
} {
  const server = fakeServer()
  const parked = new ParkedPrompts()
  const injectPrompt = vi.fn()
  const hub = new CompanionHub({
    server,
    parked,
    snapshots: () => statuses,
    snapshot: (tabId) => statuses.find((s) => s.tabId === tabId) ?? null,
    injectPrompt
  })
  hub.start()
  return { hub, server, parked, injectPrompt }
}

/** Park a prompt and return its id. */
function park(parked: ParkedPrompts, tabId = 't1', tool = 'Bash'): string {
  parked.tryPark(
    tabId,
    {
      hook_event_name: tool === 'AskUserQuestion' ? 'PreToolUse' : 'PermissionRequest',
      tool_name: tool,
      tool_input: tool === 'AskUserQuestion' ? { questions: [] } : { command: 'ls' }
    },
    fakeRes()
  )
  return parked.pending().at(-1)!.id
}

describe('toSession', () => {
  it('names the row after the folder the session is in', () => {
    expect(toSession(tabStatus(), []).folder).toBe('thing')
  })

  it('prefers the current directory the session reports, when it has moved', () => {
    const status = tabStatus({
      payload: { workspace: { current_dir: '/Users/rob/Dev/elsewhere' } }
    })
    expect(toSession(status, []).folder).toBe('elsewhere')
  })

  it('carries branch and model when known, null when not', () => {
    const bare = toSession(tabStatus(), [])
    expect(bare.branch).toBeNull()
    expect(bare.model).toBeNull()

    const rich = toSession(
      tabStatus({
        git: {
          branch: 'feature/x',
          changed: 0,
          unpushed: 0,
          behind: 0,
          remoteUrl: '',
          prUrl: null
        } as TabStatus['git'],
        payload: { model: { display_name: 'Opus 5' } }
      }),
      ['p1']
    )
    expect(rich.branch).toBe('feature/x')
    expect(rich.model).toBe('Opus 5')
    expect(rich.pendingPromptIds).toEqual(['p1'])
  })
})

describe('CompanionHub', () => {
  it('parks prompts only while a device is connected', () => {
    const { server, parked } = setup()
    expect(parked.canPark('t1')).toBe(true)
    server.authed = 0
    expect(parked.canPark('t1')).toBe(false)
  })

  it('announces a parked prompt and its resolution', () => {
    const { server, parked } = setup()
    const id = park(parked)
    expect(server.broadcasts[0]).toMatchObject({ type: 'prompt' })

    parked.decide(id, { kind: 'allow' })
    expect(server.broadcasts[1]).toEqual({
      type: 'promptResolved',
      promptId: id,
      tabId: 't1',
      outcome: 'answered'
    })
  })

  it('hands held prompts back when the last device disconnects', () => {
    const { server, parked } = setup()
    park(parked)
    expect(parked.pending()).toHaveLength(1)
    server.onPresence(0)
    expect(parked.pending()).toHaveLength(0)
  })

  it('keeps holding while at least one device is still there', () => {
    const { server, parked } = setup()
    park(parked)
    server.onPresence(1)
    expect(parked.pending()).toHaveLength(1)
  })

  it('answers a session list request', () => {
    const { server } = setup()
    server.onFrame('d1', { type: 'sessions' } as never)
    expect(server.sent[0].frame).toMatchObject({
      type: 'sessions',
      sessions: [{ tabId: 't1', folder: 'thing' }]
    })
  })

  it('lists a prompt against the session that is blocked on it', () => {
    const { hub, parked } = setup()
    const id = park(parked)
    expect(hub.sessionList()[0].pendingPromptIds).toEqual([id])
  })

  it('applies a decision from a device', () => {
    const { server, parked } = setup()
    const id = park(parked)
    server.onFrame('d1', { type: 'decide', promptId: id, decision: { kind: 'allow' } } as never)
    expect(parked.pending()).toHaveLength(0)
    expect(server.sent).toHaveLength(0)
  })

  it('says so when a prompt has already gone — the usual race with the terminal', () => {
    const { server } = setup()
    server.onFrame('d1', {
      type: 'decide',
      promptId: 'stale',
      decision: { kind: 'allow' }
    } as never)
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-such-prompt' })
  })

  it('distinguishes an answer this prompt cannot carry', () => {
    const { server, parked } = setup()
    const id = park(parked) // a PermissionRequest cannot deliver text
    server.onFrame('d1', {
      type: 'decide',
      promptId: id,
      decision: { kind: 'respond', text: 'Spaces' }
    } as never)
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'undeliverable' })
    // and it is still held, so it can still be answered properly
    expect(parked.pending()).toHaveLength(1)
  })

  it('delivers text to a question, which can carry it', () => {
    const { server, parked } = setup()
    const id = park(parked, 't1', 'AskUserQuestion')
    server.onFrame('d1', {
      type: 'decide',
      promptId: id,
      decision: { kind: 'respond', text: 'Spaces' }
    } as never)
    expect(server.sent).toHaveLength(0)
    expect(parked.pending()).toHaveLength(0)
  })

  it('submits a prompt through the injection path the app itself uses', () => {
    const { server, injectPrompt } = setup()
    server.onFrame('d1', { type: 'submit', tabId: 't1', text: 'do the thing' } as never)
    expect(injectPrompt).toHaveBeenCalledWith('t1', 'do the thing')
  })

  it('refuses to submit into a tab with no live session', () => {
    const { server, injectPrompt } = setup([tabStatus({ claudeActive: false })])
    server.onFrame('d1', { type: 'submit', tabId: 't1', text: 'hi' } as never)
    expect(injectPrompt).not.toHaveBeenCalled()
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-such-session' })
  })

  it('refuses to submit into a tab that does not exist', () => {
    const { server, injectPrompt } = setup()
    server.onFrame('d1', { type: 'submit', tabId: 'nope', text: 'hi' } as never)
    expect(injectPrompt).not.toHaveBeenCalled()
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-such-session' })
  })

  it('pushes a single session on a status change', () => {
    const { hub, server } = setup()
    hub.publishStatus(tabStatus({ activity: 'idle' }))
    expect(server.broadcasts[0]).toMatchObject({
      type: 'session',
      session: { tabId: 't1', activity: 'idle' }
    })
  })
})
