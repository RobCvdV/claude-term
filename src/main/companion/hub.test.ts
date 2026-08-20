import { describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '../../shared/companion'
import type { TabStatus } from '../../shared/types'
import { ConversationFeed } from './conversation-feed'
import { PromptQueue } from './prompt-queue'
import { CompanionHub, toSession } from './hub'
import { ParkedPrompts, type ParkedResponse } from './parked-prompts'
import type { CompanionServer } from './server'

const SCREEN_ROWS = ['> ready', '  waiting for input']

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
    onGone: (() => {}) as (deviceId: string) => void,
    onFrame: (() => {}) as (deviceId: string, frame: never) => void
  }
  return api as unknown as ReturnType<typeof fakeServer>
}

function setup(statuses: TabStatus[] = [tabStatus()]): {
  hub: CompanionHub
  server: ReturnType<typeof fakeServer>
  parked: ParkedPrompts
  feed: ConversationFeed
  injectPrompt: ReturnType<typeof vi.fn>
  screen: ReturnType<typeof vi.fn>
  addRule: ReturnType<typeof vi.fn>
  queue: PromptQueue
} {
  const server = fakeServer()
  const parked = new ParkedPrompts()
  const injectPrompt = vi.fn()
  const screen = vi.fn(async () => SCREEN_ROWS as string[] | null)
  const addRule = vi.fn(() => true)
  const queue = new PromptQueue({
    deliver: injectPrompt,
    ready: (tabId) => {
      const s = statuses.find((x) => x.tabId === tabId)
      return Boolean(s?.claudeActive) && s?.activity !== 'needs-attention'
    }
  })
  const feed = new ConversationFeed({
    turnsFor: () => [{ role: 'claude', time: null, text: 'hello there' }],
    sessionOf: (tabId) => statuses.find((s) => s.tabId === tabId)?.sessionId ?? null
  })
  const hub = new CompanionHub({
    server,
    parked,
    feed,
    snapshots: () => statuses,
    snapshot: (tabId) => statuses.find((s) => s.tabId === tabId) ?? null,
    queue,
    screen,
    addRule
  })
  hub.start()
  return { hub, server, parked, feed, injectPrompt, screen, addRule, queue }
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

  it('hands a subscriber the conversation so far', () => {
    const { server } = setup()
    server.onFrame('d1', { type: 'subscribe', tabId: 't1' } as never)
    expect(server.sent[0].frame).toMatchObject({
      type: 'conversation',
      tabId: 't1',
      turns: [{ role: 'claude', text: 'hello there' }],
      before: 0
    })
  })

  it('refuses to follow a tab that does not exist', () => {
    const { server, feed } = setup()
    server.onFrame('d1', { type: 'subscribe', tabId: 'nope' } as never)
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-such-session' })
    expect(feed.active()).toBe(0)
  })

  it('says so when a followed session has written nothing yet', () => {
    const server = fakeServer()
    const statuses = [tabStatus()]
    const hub = new CompanionHub({
      server,
      parked: new ParkedPrompts(),
      feed: new ConversationFeed({ turnsFor: () => null, sessionOf: () => 's1' }),
      snapshots: () => statuses,
      snapshot: () => statuses[0],
      queue: new PromptQueue({ deliver: () => {}, ready: () => true }),
      screen: async () => SCREEN_ROWS
    })
    hub.start()
    server.onFrame('d1', { type: 'subscribe', tabId: 't1' } as never)
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-transcript' })
    hub.stop()
  })

  it('stops following on unsubscribe', () => {
    const { server, feed } = setup()
    server.onFrame('d1', { type: 'subscribe', tabId: 't1' } as never)
    expect(feed.active()).toBe(1)
    server.onFrame('d1', { type: 'unsubscribe' } as never)
    expect(feed.active()).toBe(0)
  })

  it('stops following a device whose socket went away', () => {
    const { server, feed } = setup()
    server.onFrame('d1', { type: 'subscribe', tabId: 't1' } as never)
    server.onGone('d1')
    expect(feed.active()).toBe(0)
  })

  it('sends appended turns as a delta, not the whole conversation again', () => {
    const turns = [{ role: 'claude' as const, time: null, text: 'first' }]
    const server = fakeServer()
    const statuses = [tabStatus()]
    const hub = new CompanionHub({
      server,
      parked: new ParkedPrompts(),
      feed: new ConversationFeed({ turnsFor: () => turns, sessionOf: () => 's1' }),
      snapshots: () => statuses,
      snapshot: () => statuses[0],
      queue: new PromptQueue({ deliver: () => {}, ready: () => true }),
      screen: async () => SCREEN_ROWS
    })
    hub.start()
    server.onFrame('d1', { type: 'subscribe', tabId: 't1' } as never)
    turns.push({ role: 'claude', time: null, text: 'second' })
    hub.pushDeltas()
    expect(server.sent[1].frame).toMatchObject({
      type: 'conversationDelta',
      turns: [{ text: 'second' }]
    })
    hub.stop()
  })

  it('hands over a screen snapshot on request', async () => {
    const { server, screen } = setup()
    server.onFrame('d1', { type: 'screen', tabId: 't1' } as never)
    await Promise.resolve()
    expect(screen).toHaveBeenCalledWith('t1')
    expect(server.sent[0].frame).toMatchObject({
      type: 'screen',
      tabId: 't1',
      rows: ['> ready', '  waiting for input']
    })
  })

  it('says so when the app cannot produce a screen', async () => {
    const { server, screen } = setup()
    screen.mockResolvedValueOnce(null)
    server.onFrame('d1', { type: 'screen', tabId: 't1' } as never)
    await Promise.resolve()
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-screen' })
  })

  it('refuses a screen for a tab that does not exist', async () => {
    const { server, screen } = setup()
    server.onFrame('d1', { type: 'screen', tabId: 'nope' } as never)
    await Promise.resolve()
    expect(screen).not.toHaveBeenCalled()
    expect(server.sent[0].frame).toMatchObject({ type: 'error', code: 'no-such-session' })
  })

  it('writes the suggested rule when asked to remember, then approves', () => {
    const { server, parked, addRule } = setup()
    const id = park(parked) // Bash(ls) → suggests a rule
    server.onFrame('d1', {
      type: 'decide',
      promptId: id,
      decision: { kind: 'allow', remember: true }
    } as never)
    expect(addRule).toHaveBeenCalledWith('/Users/rob/Dev/thing', 'Bash(ls)')
    expect(server.sent[0].frame).toMatchObject({ type: 'ruleAdded', rule: 'Bash(ls)', added: true })
    expect(parked.pending()).toHaveLength(0)
  })

  it('approves without a rule when there is none worth offering', () => {
    const { server, parked, addRule } = setup()
    // a question carries no shell command, so no rule is suggested
    const id = park(parked, 't1', 'AskUserQuestion')
    server.onFrame('d1', {
      type: 'decide',
      promptId: id,
      decision: { kind: 'allow', remember: true }
    } as never)
    expect(addRule).not.toHaveBeenCalled()
    expect(server.sent).toHaveLength(0)
  })

  it('still approves when the rule could not be written', () => {
    const { server, parked, addRule } = setup()
    addRule.mockReturnValueOnce(false)
    const id = park(parked)
    server.onFrame('d1', {
      type: 'decide',
      promptId: id,
      decision: { kind: 'allow', remember: true }
    } as never)
    expect(server.sent[0].frame).toMatchObject({ type: 'ruleAdded', added: false })
    expect(parked.pending()).toHaveLength(0)
  })

  it('holds a submitted prompt while a dialog owns the keyboard', () => {
    const { server, injectPrompt } = setup([tabStatus({ activity: 'needs-attention' })])
    server.onFrame('d1', { type: 'submit', tabId: 't1', text: 'later please' } as never)
    expect(injectPrompt).not.toHaveBeenCalled()
    expect(server.broadcasts[0]).toEqual({ type: 'submitQueued', tabId: 't1', position: 1 })
  })

  it('delivers what was held once the dialog is gone', () => {
    const statuses = [tabStatus({ activity: 'needs-attention' })]
    const server = fakeServer()
    const injectPrompt = vi.fn()
    const queue = new PromptQueue({
      deliver: injectPrompt,
      ready: (tabId) => statuses.find((s) => s.tabId === tabId)?.activity !== 'needs-attention'
    })
    const hub = new CompanionHub({
      server,
      parked: new ParkedPrompts(),
      feed: new ConversationFeed({ turnsFor: () => null, sessionOf: () => null }),
      queue,
      snapshots: () => statuses,
      snapshot: (tabId) => statuses.find((s) => s.tabId === tabId) ?? null,
      screen: async () => null
    })
    hub.start()
    server.onFrame('d1', { type: 'submit', tabId: 't1', text: 'later please' } as never)
    expect(injectPrompt).not.toHaveBeenCalled()

    statuses[0] = tabStatus({ activity: 'idle' })
    hub.publishStatus(statuses[0])
    expect(injectPrompt).toHaveBeenCalledWith('t1', 'later please')
    expect(server.broadcasts.some((f) => f.type === 'submitDelivered')).toBe(true)
    hub.stop()
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
