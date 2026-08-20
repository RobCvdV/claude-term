import { describe, expect, it, vi } from 'vitest'
import {
  canDeliver,
  decisionBody,
  ParkedPrompts,
  promptKind,
  promptSummary,
  type ParkedResponse
} from './parked-prompts'
import type { HookEvent } from '../../shared/types'
import type { PendingPrompt, PromptOutcome } from '../../shared/companion'

function fakeRes(): ParkedResponse & { body: string | null; closers: (() => void)[] } {
  return {
    writableEnded: false,
    body: null,
    closers: [],
    writeHead() {
      return this
    },
    end(body?: string) {
      this.body = body ?? ''
      this.writableEnded = true
    },
    on(_event: 'close', fn: () => void) {
      this.closers.push(fn)
      return this
    }
  }
}

const permission = (over: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'mkdir out', description: 'make a dir' },
  ...over
})

const question = (): HookEvent => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{ question: 'Tabs or spaces?', header: 'Indent', options: [{ label: 'Spaces' }] }]
  }
})

const plan = (): HookEvent => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  tool_name: 'ExitPlanMode',
  tool_input: { plan: '# Plan\ndo the thing', planFilePath: '/tmp/p.md' }
})

function listening(): ParkedPrompts {
  const parked = new ParkedPrompts()
  parked.canPark = () => true
  return parked
}

describe('promptKind / promptSummary', () => {
  it('separates the two tools whose answer is content', () => {
    expect(promptKind('AskUserQuestion')).toBe('question')
    expect(promptKind('ExitPlanMode')).toBe('plan')
    expect(promptKind('Bash')).toBe('permission')
  })

  it('names what is being asked about, falling back to the tool', () => {
    expect(promptSummary('Bash', { command: 'rm -rf x' })).toBe('rm -rf x')
    expect(promptSummary('Write', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(promptSummary('Weird', {})).toBe('Weird')
  })
})

describe('decisionBody', () => {
  it('answers PermissionRequest with decision.behavior', () => {
    expect(JSON.parse(decisionBody('PermissionRequest', { kind: 'allow' })!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
    expect(
      JSON.parse(decisionBody('PermissionRequest', { kind: 'deny' })!).hookSpecificOutput.decision
    ).toEqual({ behavior: 'deny' })
  })

  it('answers PreToolUse with permissionDecision, carrying the text to the model', () => {
    expect(JSON.parse(decisionBody('PreToolUse', { kind: 'respond', text: 'Spaces' })!)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Spaces'
      }
    })
  })

  it('approves a PreToolUse prompt by declining to decide it', () => {
    // the PermissionRequest behind it is what actually allows the tool
    expect(decisionBody('PreToolUse', { kind: 'allow' })).toBeNull()
  })

  it('release means no decision at all', () => {
    expect(decisionBody('PermissionRequest', { kind: 'release' })).toBeNull()
  })

  it('refuses to route text through PermissionRequest, which would drop it', () => {
    expect(canDeliver('PermissionRequest', { kind: 'respond', text: 'Spaces' })).toBe(false)
    expect(canDeliver('PreToolUse', { kind: 'respond', text: 'Spaces' })).toBe(true)
  })
})

describe('ParkedPrompts', () => {
  it('declines to park when nobody is listening', () => {
    const parked = new ParkedPrompts()
    expect(parked.tryPark('t1', permission(), fakeRes())).toBe(false)
    expect(parked.pending()).toHaveLength(0)
  })

  it('ignores hooks it cannot decide', () => {
    const parked = listening()
    expect(parked.tryPark('t1', { hook_event_name: 'Stop' }, fakeRes())).toBe(false)
  })

  it('never parks an ordinary tool call arriving on PreToolUse', () => {
    const parked = listening()
    const evt: HookEvent = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }
    expect(parked.tryPark('t1', evt, fakeRes())).toBe(false)
  })

  it('holds the response open until answered', () => {
    const parked = listening()
    const res = fakeRes()
    expect(parked.tryPark('t1', permission(), res)).toBe(true)
    expect(res.writableEnded).toBe(false)

    const [prompt] = parked.pending()
    expect(prompt.summary).toBe('mkdir out')
    expect(parked.decide(prompt.id, { kind: 'allow' })).toBe(true)
    expect(JSON.parse(res.body!).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(parked.pending()).toHaveLength(0)
  })

  it('surfaces a question with its options intact', () => {
    const parked = listening()
    parked.tryPark('t1', question(), fakeRes())
    const [prompt] = parked.pending()
    expect(prompt.kind).toBe('question')
    expect(prompt.questions?.[0].question).toBe('Tabs or spaces?')
  })

  it('surfaces a plan with its markdown and file path', () => {
    const parked = listening()
    parked.tryPark('t1', plan(), fakeRes())
    const [prompt] = parked.pending()
    expect(prompt.kind).toBe('plan')
    expect(prompt.plan).toContain('do the thing')
    expect(prompt.planFilePath).toBe('/tmp/p.md')
  })

  it('rejects text answers on a prompt that cannot carry them', () => {
    const parked = listening()
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    const [prompt] = parked.pending()
    expect(parked.decide(prompt.id, { kind: 'respond', text: 'nope' })).toBe(false)
    // still held, so the user can still answer it properly
    expect(res.writableEnded).toBe(false)
    expect(parked.pending()).toHaveLength(1)
  })

  it('approving at PreToolUse pre-authorises the PermissionRequest behind it', () => {
    const parked = listening()
    parked.tryPark('t1', plan(), fakeRes())
    const [prompt] = parked.pending()
    parked.decide(prompt.id, { kind: 'allow' })

    const second = fakeRes()
    const followUp = permission({ tool_name: 'ExitPlanMode', tool_input: {} })
    expect(parked.tryPark('t1', followUp, second)).toBe(true)
    // answered straight away, never shown to the device a second time
    expect(JSON.parse(second.body!).hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
    expect(parked.pending()).toHaveLength(0)
  })

  it('spends a pre-approval only once, and only for that tool', () => {
    const parked = listening()
    parked.tryPark('t1', plan(), fakeRes())
    parked.decide(parked.pending()[0].id, { kind: 'allow' })

    const other = permission({ tool_name: 'Bash' })
    parked.tryPark('t1', other, fakeRes())
    expect(parked.pending()).toHaveLength(1) // Bash is not what was approved
    parked.releaseAll()

    parked.tryPark('t1', permission({ tool_name: 'ExitPlanMode', tool_input: {} }), fakeRes())
    parked.pending().forEach((p) => parked.decide(p.id, { kind: 'release' }))
    const third = fakeRes()
    parked.tryPark('t1', permission({ tool_name: 'ExitPlanMode', tool_input: {} }), third)
    expect(third.writableEnded).toBe(false) // the approval was already spent
  })

  it('reports a terminal answer when the CLI closes the connection', () => {
    const parked = listening()
    const outcomes: PromptOutcome[] = []
    parked.onResolved = (_p, outcome) => outcomes.push(outcome)
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    res.closers.forEach((fn) => fn())
    expect(outcomes).toEqual(['terminal'])
    expect(parked.pending()).toHaveLength(0)
  })

  it('is idempotent: a resolved prompt cannot be answered again', () => {
    const parked = listening()
    const onResolved = vi.fn()
    parked.onResolved = onResolved
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    const id = parked.pending()[0].id
    expect(parked.decide(id, { kind: 'allow' })).toBe(true)
    expect(parked.decide(id, { kind: 'deny' })).toBe(false)
    res.closers.forEach((fn) => fn())
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('releasing hands the prompt back with no decision', () => {
    const parked = listening()
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    parked.decide(parked.pending()[0].id, { kind: 'release' })
    expect(res.body).toBe('{}')
  })

  it('releases everything on shutdown so no session is left hanging', () => {
    const parked = listening()
    const seen: PendingPrompt[] = []
    parked.onResolved = (p) => seen.push(p)
    const a = fakeRes()
    const b = fakeRes()
    parked.tryPark('t1', permission(), a)
    parked.tryPark('t2', permission(), b)
    parked.releaseAll('shutdown')
    expect([a.body, b.body]).toEqual(['{}', '{}'])
    expect(seen).toHaveLength(2)
    expect(parked.pending()).toHaveLength(0)
  })

  it('releases only the tab asked for', () => {
    const parked = listening()
    parked.tryPark('t1', permission(), fakeRes())
    parked.tryPark('t2', permission(), fakeRes())
    parked.releaseTab('t1')
    expect(parked.pending().map((p) => p.tabId)).toEqual(['t2'])
  })
})
