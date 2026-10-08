import { describe, expect, it, vi } from 'vitest'
import { handleModRequest } from './mod-requests'
import { ParkedPrompts } from './parked-prompts'

function setup(canPark = true): { parked: ParkedPrompts; dialogOpen: (tabId: string) => void } {
  const parked = new ParkedPrompts()
  parked.canPark = () => canPark
  return { parked, dialogOpen: vi.fn<(tabId: string) => void>() }
}

const questions = [{ question: 'Tabs or spaces?', options: [{ label: 'Spaces' }] }]

describe('handleModRequest', () => {
  it('parks a question and marks the tab as waiting', async () => {
    const deps = setup()
    const r = (await handleModRequest(deps, 't1', 'park', {
      session_id: 's1',
      toolName: 'AskUserQuestion',
      input: { questions }
    })) as { id: string }
    expect(deps.parked.pending()[0]).toMatchObject({ id: r.id, hook: 'mod', kind: 'question' })
    expect(deps.dialogOpen).toHaveBeenCalledWith('t1')
  })

  it('parks nothing, and says so, when no phone is paired', async () => {
    const deps = setup(false)
    const r = await handleModRequest(deps, 't1', 'park', { toolName: 'AskUserQuestion' })
    expect(r).toEqual({ id: null })
    expect(deps.dialogOpen).not.toHaveBeenCalled()
  })

  it('carries a phone answer back through wait', async () => {
    const deps = setup()
    const { id } = (await handleModRequest(deps, 't1', 'park', {
      toolName: 'AskUserQuestion',
      input: { questions }
    })) as { id: string }
    deps.parked.decide(id, { kind: 'respond', text: 'Spaces' })
    expect(await handleModRequest(deps, 't1', 'wait', { id })).toEqual({
      decision: { kind: 'respond', text: 'Spaces' }
    })
  })

  it('closes a prompt the terminal answered', async () => {
    const deps = setup()
    const { id } = (await handleModRequest(deps, 't1', 'park', {
      toolName: 'AskUserQuestion',
      input: { questions }
    })) as { id: string }
    await handleModRequest(deps, 't1', 'close', { id })
    expect(deps.parked.pending()).toEqual([])
  })

  it('approves the exact re-run of a reasked permission', async () => {
    const deps = setup(false)
    const input = { command: 'mkdir out' }
    await handleModRequest(deps, 't1', 'approve', { toolName: 'Bash', input })
    const res = {
      writableEnded: false,
      body: '',
      writeHead: () => undefined,
      end(b?: string) {
        this.body = b ?? ''
        this.writableEnded = true
      },
      on: () => undefined
    }
    const evt = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }
    expect(deps.parked.tryPark('t1', evt, res)).toBe(true)
    expect(res.body).toContain('"allow"')
  })

  it('ignores what it does not understand', async () => {
    expect(await handleModRequest(setup(), 't1', 'nope', {})).toEqual({})
    expect(await handleModRequest(setup(), 't1', 'wait', {})).toEqual({ gone: true })
  })
})
