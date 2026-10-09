import { describe, expect, it, vi } from 'vitest'
import {
  canDeliver,
  decisionBody,
  EXPIRED_REASON,
  ParkedPrompts,
  STALE_MS,
  promptKind,
  promptSummary,
  type ParkedResponse
} from './parked-prompts'
import type { HookEvent } from '../../shared/types'
import type { PendingPrompt, PromptOutcome } from 'claude-term-protocol'

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

const held = (over: Partial<PendingPrompt>): PendingPrompt => ({
  id: 'p',
  tabId: 't1',
  sessionId: 's1',
  hook: 'PermissionRequest',
  kind: 'permission',
  toolName: 'Bash',
  summary: 'mkdir out',
  questions: null,
  plan: null,
  planFilePath: null,
  toolInput: {},
  suggestedRule: null,
  createdAt: 0,
  ...over
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
    const text = { kind: 'respond', text: 'Spaces' } as const
    expect(canDeliver(held({ hook: 'PermissionRequest' }), text)).toBe(false)
    expect(canDeliver(held({ hook: 'PreToolUse', kind: 'plan' }), text)).toBe(true)
  })

  it('answers a question with text and nothing else', () => {
    const q = held({ hook: 'mod', kind: 'question' })
    expect(canDeliver(q, { kind: 'respond', text: 'Spaces' })).toBe(true)
    expect(canDeliver(q, { kind: 'allow' })).toBe(false)
    expect(canDeliver(q, { kind: 'release' })).toBe(true)
  })

  it('takes allow or deny on a reasked permission, never text', () => {
    const p = held({ hook: 'mod', reasked: true })
    expect(canDeliver(p, { kind: 'allow' })).toBe(true)
    expect(canDeliver(p, { kind: 'deny', reason: 'no' })).toBe(true)
    expect(canDeliver(p, { kind: 'respond', text: 'x' })).toBe(false)
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

  it('leaves questions to the mod, on either hook', () => {
    const parked = listening()
    expect(parked.tryPark('t1', question(), fakeRes())).toBe(false)
    const viaPermission = { ...question(), hook_event_name: 'PermissionRequest' }
    expect(parked.tryPark('t1', viaPermission, fakeRes())).toBe(false)
  })

  it('surfaces a question the mod holds with its options intact', () => {
    const parked = listening()
    const input = question().tool_input as Record<string, unknown>
    const prompt = parked.parkForMod('t1', { sessionId: 's1', toolName: 'AskUserQuestion', input })
    expect(prompt?.kind).toBe('question')
    expect(prompt?.questions?.[0].question).toBe('Tabs or spaces?')
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

  it('ends a card whose call ran after a terminal answer, the CLI holding on', () => {
    const parked = listening()
    const outcomes: PromptOutcome[] = []
    parked.onResolved = (_p, outcome) => outcomes.push(outcome)
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    parked.tryPark('t1', permission({ tool_input: { command: 'ls' } }), fakeRes())
    parked.noteHook('t1', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { description: 'make a dir', command: 'mkdir out' }
    })
    expect(outcomes).toEqual(['terminal'])
    expect(res.body).toBe('{}')
    expect(parked.pending().map((p) => p.summary)).toEqual(['ls'])
  })

  it('ends a card whose input the dialog edited before it ran', () => {
    const parked = listening()
    parked.tryPark('t1', permission(), fakeRes())
    parked.noteHook('t1', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'mkdir -p out' }
    })
    expect(parked.pending()).toHaveLength(0)
  })

  it('ends every card of a tab whose turn moved on', () => {
    const parked = listening()
    parked.tryPark('t1', permission(), fakeRes())
    parked.tryPark('t1', plan(), fakeRes())
    parked.tryPark('t2', permission(), fakeRes())
    parked.noteHook('t1', { hook_event_name: 'UserPromptSubmit' })
    expect(parked.pending().map((p) => p.tabId)).toEqual(['t2'])
  })

  it('ends a card once the prompt box is back after its dialog, Esc included', () => {
    const parked = listening()
    parked.noteKeys('t1', 'prompt')
    parked.tryPark('t1', permission(), fakeRes())
    // the box still reads as it did before the dialog drew
    parked.noteKeys('t1', 'typing')
    expect(parked.pending()).toHaveLength(1)
    parked.noteKeys('t1', 'dialog')
    parked.noteKeys('t1', 'prompt')
    expect(parked.pending()).toHaveLength(0)
  })

  it('counts a dialog the mod saw before the hook arrived', () => {
    const parked = listening()
    parked.noteKeys('t1', 'dialog')
    parked.tryPark('t1', permission(), fakeRes())
    parked.noteKeys('t1', 'prompt')
    expect(parked.pending()).toHaveLength(0)
  })

  it('leaves cards the mod holds to the mod', () => {
    const parked = listening()
    parked.parkForMod('t1', { sessionId: 's1', toolName: 'AskUserQuestion', input: {} })
    parked.noteKeys('t1', 'dialog')
    parked.noteKeys('t1', 'prompt')
    parked.noteHook('t1', { hook_event_name: 'Stop' })
    expect(parked.pending()).toHaveLength(1)
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

describe('ParkedPrompts expiry', () => {
  it('denies a permission just before the CLI would give up, with the reason the mod re-asks on', () => {
    vi.useFakeTimers()
    const parked = new ParkedPrompts(1_000)
    parked.canPark = () => true
    const outcomes: PromptOutcome[] = []
    parked.onResolved = (_p, o) => outcomes.push(o)
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    vi.advanceTimersByTime(1_000)
    expect(JSON.parse(res.body as string).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: EXPIRED_REASON
    })
    expect(outcomes).toEqual(['expired'])
    expect(parked.pending()).toEqual([])
    vi.useRealTimers()
  })

  it('hands an expiring plan back to the terminal rather than denying it', () => {
    vi.useFakeTimers()
    const parked = new ParkedPrompts(1_000)
    parked.canPark = () => true
    const res = fakeRes()
    parked.tryPark('t1', plan(), res)
    vi.advanceTimersByTime(1_000)
    expect(res.body).toBe('{}')
    vi.useRealTimers()
  })

  it('does not expire a prompt that was answered', () => {
    vi.useFakeTimers()
    const parked = new ParkedPrompts(1_000)
    parked.canPark = () => true
    const res = fakeRes()
    parked.tryPark('t1', permission(), res)
    parked.decide(parked.pending()[0].id, { kind: 'allow' })
    const body = res.body
    vi.advanceTimersByTime(5_000)
    expect(res.body).toBe(body)
    vi.useRealTimers()
  })
})

describe('ParkedPrompts approveOnce', () => {
  it('lets exactly that call through once, whatever order its input keys are in', () => {
    const parked = new ParkedPrompts()
    parked.approveOnce('t1', 'Bash', { description: 'make a dir', command: 'mkdir out' })
    const first = fakeRes()
    expect(parked.tryPark('t1', permission(), first)).toBe(true)
    expect(JSON.parse(first.body as string).hookSpecificOutput.decision.behavior).toBe('allow')
    expect(parked.tryPark('t1', permission(), fakeRes())).toBe(false)
  })

  it('does not stretch to another command or another tab', () => {
    const parked = new ParkedPrompts()
    parked.approveOnce('t1', 'Bash', { command: 'mkdir out', description: 'make a dir' })
    const other = permission({ tool_input: { command: 'rm -rf out', description: 'make a dir' } })
    expect(parked.tryPark('t1', other, fakeRes())).toBe(false)
    expect(parked.tryPark('t2', permission(), fakeRes())).toBe(false)
  })
})

describe('ParkedPrompts for the mod', () => {
  const ask = {
    sessionId: 's1',
    toolName: 'AskUserQuestion',
    input: question().tool_input as Record<string, unknown>
  }

  it('holds nothing when no device could answer', () => {
    expect(new ParkedPrompts().parkForMod('t1', ask)).toBeNull()
  })

  it('hands a decision to the waiting poll', async () => {
    const parked = listening()
    const prompt = parked.parkForMod('t1', ask)!
    expect(prompt.hook).toBe('mod')
    const wait = parked.waitForMod(prompt.id, 5_000)
    expect(parked.decide(prompt.id, { kind: 'respond', text: 'Spaces' })).toBe(true)
    expect(await wait).toEqual({ decision: { kind: 'respond', text: 'Spaces' } })
    expect(parked.pending()).toEqual([])
  })

  it('keeps a decision that lands between two polls', async () => {
    const parked = listening()
    const prompt = parked.parkForMod('t1', ask)!
    parked.decide(prompt.id, { kind: 'respond', text: 'Spaces' })
    expect(await parked.waitForMod(prompt.id)).toEqual({
      decision: { kind: 'respond', text: 'Spaces' }
    })
    expect(await parked.waitForMod(prompt.id)).toEqual({ gone: true })
  })

  it('tells the poll to come back when nothing happened', async () => {
    vi.useFakeTimers()
    const parked = listening()
    const prompt = parked.parkForMod('t1', ask)!
    const wait = parked.waitForMod(prompt.id, 1_000)
    vi.advanceTimersByTime(1_000)
    expect(await wait).toEqual({ pending: true })
    vi.useRealTimers()
  })

  it('a release stops holding it without answering', async () => {
    const parked = listening()
    const prompt = parked.parkForMod('t1', ask)!
    const wait = parked.waitForMod(prompt.id, 5_000)
    parked.decide(prompt.id, { kind: 'release' })
    // the user chose the terminal: the mod must not offer it again
    expect(await wait).toEqual({ gone: true, released: true })
  })

  it('takes a card nobody polls for off the phone, and lets the mod offer it again', async () => {
    const parked = listening()
    const outcomes: PromptOutcome[] = []
    parked.onResolved = (_p, o) => outcomes.push(o)
    const prompt = parked.parkForMod('t1', ask)!
    parked.sweepStale(Date.now() + 60_000)
    expect(parked.pending()).toHaveLength(1)
    parked.sweepStale(Date.now() + STALE_MS + 1)
    expect(parked.pending()).toEqual([])
    expect(outcomes).toEqual(['expired'])
    // no `released`: the mod parks it anew when it can reach us again
    expect(await parked.waitForMod(prompt.id)).toEqual({ gone: true })
  })

  it('never sweeps a card whose mod is polling right now', () => {
    const parked = listening()
    const prompt = parked.parkForMod('t1', ask)!
    void parked.waitForMod(prompt.id, 1_000_000)
    parked.sweepStale(Date.now() + STALE_MS * 10)
    expect(parked.pending()).toHaveLength(1)
    parked.closeForMod(prompt.id)
  })

  it('reports a terminal answer the mod saw first', () => {
    const parked = listening()
    const outcomes: PromptOutcome[] = []
    parked.onResolved = (_p, o) => outcomes.push(o)
    const prompt = parked.parkForMod('t1', ask)!
    parked.closeForMod(prompt.id)
    expect(outcomes).toEqual(['terminal'])
    expect(parked.decide(prompt.id, { kind: 'respond', text: 'late' })).toBe(false)
  })

  it('marks a reasked permission and offers no rule to remember', () => {
    const parked = listening()
    const prompt = parked.parkForMod('t1', {
      sessionId: 's1',
      toolName: 'Bash',
      input: { command: 'mkdir out' },
      reasked: true
    })!
    expect(prompt.kind).toBe('permission')
    expect(prompt.reasked).toBe(true)
    expect(prompt.suggestedRule).toBeNull()
  })
})
