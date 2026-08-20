import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'http'
import { ParkedPrompts } from './companion/parked-prompts'
import { StatusServer } from './status-server'
import type { HookEvent } from '../shared/types'

/**
 * Exercises the real HTTP path a Claude Code `type: "http"` hook takes, so the
 * contract in docs/companion-hook-protocol.md is asserted against our own
 * server rather than only against the CLI.
 */

let server: StatusServer
let parked: ParkedPrompts

/** POST a hook body; resolves with the response once the server answers. */
function postHook(evt: HookEvent, tab = 't1'): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(evt)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: `/hook?tab=${tab}&token=${server.token}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const permissionEvent: HookEvent = {
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'mkdir out' }
}

beforeEach(async () => {
  parked = new ParkedPrompts()
  server = new StatusServer()
  server.parkHook = (tabId, evt, res) => parked.tryPark(tabId, evt, res)
  await server.start()
  server.registerTab('t1', '/tmp')
})

afterEach(() => {
  parked.releaseAll('shutdown')
  server.stop()
})

describe('StatusServer hook parking', () => {
  it('answers instantly when no device is listening', async () => {
    const res = await postHook(permissionEvent)
    expect(res.status).toBe(200)
    // an empty object is "no decision": the session's own dialog decides
    expect(res.body).toBe('{}')
  })

  it('still drives the tab activity state for a parked prompt', async () => {
    parked.canPark = () => true
    void postHook(permissionEvent)
    await settle()
    expect(server.snapshot('t1')?.activity).toBe('needs-attention')
    expect(parked.pending()).toHaveLength(1)
  })

  it('holds the response open, then delivers the decision', async () => {
    parked.canPark = () => true
    let settled = false
    const inflight = postHook(permissionEvent).then((r) => {
      settled = true
      return r
    })
    await settle()
    expect(settled).toBe(false) // the session is waiting on a human

    const [prompt] = parked.pending()
    expect(prompt.summary).toBe('mkdir out')
    parked.decide(prompt.id, { kind: 'allow' })

    const res = await inflight
    expect(JSON.parse(res.body).hookSpecificOutput).toEqual({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    })
  })

  it('releasing a held prompt hands it back with no decision', async () => {
    parked.canPark = () => true
    const inflight = postHook(permissionEvent)
    await settle()
    parked.decide(parked.pending()[0].id, { kind: 'release' })
    expect((await inflight).body).toBe('{}')
  })

  it('carries a question through with its options', async () => {
    parked.canPark = () => true
    void postHook({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Tabs or spaces?', options: [{ label: 'Spaces' }] }] }
    })
    await settle()
    const [prompt] = parked.pending()
    expect(prompt.kind).toBe('question')
    expect(prompt.hook).toBe('PreToolUse')
    expect(prompt.questions?.[0].options[0].label).toBe('Spaces')
  })

  it('answers a question with text the model will see', async () => {
    parked.canPark = () => true
    const inflight = postHook({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] }
    })
    await settle()
    parked.decide(parked.pending()[0].id, { kind: 'respond', text: 'Spaces' })
    expect(JSON.parse((await inflight).body).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Spaces'
    })
  })

  it('never parks an ordinary tool call on PreToolUse', async () => {
    parked.canPark = () => true
    const res = await postHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    expect(res.body).toBe('{}')
    expect(parked.pending()).toHaveLength(0)
  })

  it('reports a terminal answer when the client hangs up', async () => {
    parked.canPark = () => true
    const outcomes: string[] = []
    parked.onResolved = (_p, outcome) => outcomes.push(outcome)

    const payload = JSON.stringify(permissionEvent)
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: `/hook?tab=t1&token=${server.token}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    })
    req.on('error', () => {})
    req.end(payload)
    await settle()
    expect(parked.pending()).toHaveLength(1)

    req.destroy() // the CLI does this when the user answers in the terminal
    await settle()
    expect(outcomes).toEqual(['terminal'])
    expect(parked.pending()).toHaveLength(0)
  })

  it('rejects an unauthenticated post without parking anything', async () => {
    parked.canPark = () => true
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/hook?tab=t1&token=wrong'
        },
        (res) => resolve(res.statusCode ?? 0)
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
    expect(parked.pending()).toHaveLength(0)
  })
})
