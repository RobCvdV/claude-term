import { randomUUID } from 'crypto'
import type {
  DecidingHook,
  PendingPrompt,
  PromptDecision,
  PromptKind,
  PromptOutcome,
  QuestionSpec
} from 'claude-term-protocol'
import type { HookEvent, TabId } from '../../shared/types'
import { suggestRule } from './allow-rule'

/** Just enough of Node's ServerResponse to hold one open, so this is testable. */
export interface ParkedResponse {
  writableEnded: boolean
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body?: string): void
  on(event: 'close', listener: () => void): unknown
}

/** How long a PreToolUse approval pre-authorises the PermissionRequest behind it. */
export const PRE_APPROVAL_MS = 30_000

/** Settings hooks die at the CLI's 600 s ceiling; give up on one just before. */
export const EXPIRE_MS = 570_000

/** How long a mod's approval of one exact call stays good for its re-run. */
export const APPROVE_ONCE_MS = 60_000

/** How long one of the mod's long-polls is held before it is told to ask again. */
export const MOD_POLL_MS = 20_000

/** What an expired permission is denied with. The term-bridge mod recognises it
 *  and asks again; should the mod be missing, the model reads it as is. */
export const EXPIRED_REASON = 'claude-term: nobody answered this permission prompt in time'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export function promptKind(toolName: string): PromptKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  return 'permission'
}

/** One line naming what is being asked about, for a list row or a push body. */
export function promptSummary(toolName: string, input: Record<string, unknown>): string {
  const str = (k: string): string | null =>
    typeof input[k] === 'string' ? (input[k] as string) : null
  return (
    str('command') ??
    str('file_path') ??
    str('path') ??
    str('url') ??
    str('pattern') ??
    str('description') ??
    toolName
  )
}

/**
 * The body that answers a held-open hook, or null to reply with no decision at
 * all (which lets the session's own dialog take over).
 *
 * The two hooks disagree on shape and on what they can carry: PermissionRequest
 * takes `decision.behavior` and drops any reason, PreToolUse takes
 * `permissionDecision` and its reason is delivered to the model. Measured in
 * docs/companion-hook-protocol.md.
 */
export function decisionBody(
  hook: Exclude<DecidingHook, 'mod'>,
  decision: PromptDecision
): string | null {
  if (decision.kind === 'release') return null
  if (hook === 'PermissionRequest') {
    if (decision.kind === 'respond') return null // caller must reject this first
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: decision.kind === 'allow' ? 'allow' : 'deny' }
      }
    })
  }
  // PreToolUse: approving is best done by NOT deciding, so the normal
  // PermissionRequest flow runs and this hook stays out of the way.
  if (decision.kind === 'allow') return null
  const reason = decision.kind === 'respond' ? decision.text : decision.reason
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      ...(reason ? { permissionDecisionReason: reason } : {})
    }
  })
}

/** A decision a given hook is physically able to deliver. */
export function canDeliver(prompt: PendingPrompt, decision: PromptDecision): boolean {
  if (decision.kind === 'release') return true
  // The mod answers a question with its text; nothing else means anything there.
  if (prompt.hook === 'mod' && prompt.kind === 'question') return decision.kind === 'respond'
  // PermissionRequest silently discards the reason, so text answered there would
  // vanish — the model would only see "blocked by a permission hook".
  if (prompt.hook === 'PermissionRequest') return decision.kind !== 'respond'
  // A reasked permission has no text to carry beyond a deny's reason.
  if (prompt.hook === 'mod' && prompt.kind === 'permission') return decision.kind !== 'respond'
  return true
}

/** What the mod's long-poll comes back with. */
export type ModWait =
  | { decision: PromptDecision }
  /** nothing yet; poll again */
  | { pending: true }
  /** no longer held for a phone: released, or never known */
  | { gone: true }

/** A key for one exact tool call, insensitive to the order of its input's keys. */
export function callKey(tabId: TabId, toolName: string, input: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
          )
        : v
  return `${tabId}\n${toolName}\n${JSON.stringify(canonical(input ?? {}))}`
}

function questionsOf(input: Record<string, unknown>): QuestionSpec[] | null {
  const q = input.questions
  return Array.isArray(q) ? (q as QuestionSpec[]) : null
}

/** Where an entry's answer goes: an open settings-hook response, or the mod. */
type Sink =
  | { type: 'hook'; res: ParkedResponse; expiry: NodeJS.Timeout | null }
  | { type: 'mod'; decision: PromptDecision | null; waiters: Set<() => void> }

interface Entry {
  prompt: PendingPrompt
  sink: Sink
  done: boolean
}

/** What the mod asks to have held for a phone. */
export interface ModPark {
  sessionId: string | null
  toolName: string
  input: Record<string, unknown>
  /** a permission asked again after its settings hook expired */
  reasked?: boolean
}

/**
 * Prompts held open while a companion device decides.
 *
 * The session's own dialog is drawn immediately and in parallel, so a held
 * prompt is always still answerable at the desk, and nothing here decides on
 * the user's behalf. Exactly one of answer / release / closed-at-the-terminal /
 * expiry resolves an entry, and every path is idempotent.
 *
 * Settings hooks die at the CLI's 600 s ceiling, so a permission still waiting
 * just before that is denied with EXPIRED_REASON; the term-bridge mod then asks
 * it again as a question it can hold for as long as it takes.
 */
export class ParkedPrompts {
  private entries = new Map<string, Entry>()
  private preApproved = new Map<string, number>()
  private approvedOnce = new Map<string, number>()

  /** Set by the companion hub: is there any device a prompt could be held for? */
  canPark: (tabId: TabId) => boolean = () => false

  onParked: (prompt: PendingPrompt) => void = () => {}
  onResolved: (prompt: PendingPrompt, outcome: PromptOutcome) => void = () => {}

  constructor(private readonly expireMs = EXPIRE_MS) {}

  /**
   * Take ownership of a hook request, if it is one we can park and someone could
   * answer it. Returns true when the response is now ours to answer — the caller
   * must not touch it. Returns false to mean "reply normally".
   */
  tryPark(tabId: TabId, evt: HookEvent, res: ParkedResponse): boolean {
    const hook = evt.hook_event_name
    if (hook !== 'PermissionRequest' && hook !== 'PreToolUse') return false
    const toolName = typeof evt.tool_name === 'string' ? evt.tool_name : ''
    const input = (evt.tool_input ?? {}) as Record<string, unknown>
    const kind = promptKind(toolName)

    // Belt and braces: the overlay scopes PreToolUse with a matcher, but parking
    // an arbitrary tool call would stall the turn for no reason.
    if (hook === 'PreToolUse' && kind === 'permission') return false
    // The term-bridge mod holds questions, with no time limit; holding the
    // hook too would show the phone a second card that expires.
    if (kind === 'question') return false

    if (hook === 'PermissionRequest') {
      // The re-run of a call that was answered after its first ask expired.
      if (this.takeApprovedOnce(callKey(tabId, toolName, input))) {
        this.write(res, decisionBody('PermissionRequest', { kind: 'allow' }))
        return true
      }
      // A device already approved this at PreToolUse — don't ask it twice.
      if (this.takePreApproval(tabId, toolName)) {
        this.write(res, decisionBody('PermissionRequest', { kind: 'allow' }))
        return true
      }
    }
    if (!this.canPark(tabId)) return false

    const prompt = this.promptFor(tabId, {
      hook,
      sessionId: typeof evt.session_id === 'string' ? evt.session_id : null,
      toolName,
      input
    })
    const sink: Sink = { type: 'hook', res, expiry: null }
    const entry: Entry = { prompt, sink, done: false }
    sink.expiry = setTimeout(() => this.expire(entry), this.expireMs)
    sink.expiry.unref?.()
    this.entries.set(prompt.id, entry)
    // The CLI closes the connection when the user answers in the terminal.
    res.on('close', () => this.finish(entry, 'terminal'))
    this.onParked(prompt)
    return true
  }

  /** Hold a prompt for the term-bridge mod, which polls for the answer. */
  parkForMod(tabId: TabId, park: ModPark): PendingPrompt | null {
    if (!this.canPark(tabId)) return null
    const prompt = this.promptFor(tabId, { hook: 'mod', ...park })
    if (park.reasked) {
      prompt.reasked = true
      prompt.suggestedRule = null
    }
    this.entries.set(prompt.id, {
      prompt,
      sink: { type: 'mod', decision: null, waiters: new Set() },
      done: false
    })
    this.onParked(prompt)
    return prompt
  }

  /** The mod's long-poll: resolves on a decision, a release, or after `ms`. */
  waitForMod(id: string, ms = MOD_POLL_MS): Promise<ModWait> {
    const entry = this.entries.get(id)
    if (!entry || entry.sink.type !== 'mod') return Promise.resolve({ gone: true })
    const sink = entry.sink
    if (sink.decision) return Promise.resolve(this.takeModDecision(entry))
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        sink.waiters.delete(wake)
        resolve(
          sink.decision
            ? this.takeModDecision(entry)
            : entry.done
              ? { gone: true }
              : { pending: true }
        )
      }
      const timer = setTimeout(wake, ms)
      sink.waiters.add(wake)
    })
  }

  /** The mod saw the terminal answer first. */
  closeForMod(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.sink.type === 'mod') this.finish(entry, 'terminal')
  }

  /** Let exactly this call through its next permission check, once. */
  approveOnce(tabId: TabId, toolName: string, input: unknown): void {
    this.approvedOnce.set(callKey(tabId, toolName, input), Date.now() + APPROVE_ONCE_MS)
  }

  /** Answer a held prompt. False if it is unknown, gone, or undeliverable. */
  decide(id: string, decision: PromptDecision): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.done) return false
    if (!canDeliver(entry.prompt, decision)) return false
    const { prompt, sink } = entry
    if (sink.type === 'mod') {
      // The mod polls for it; a release just stops holding it for a phone.
      if (decision.kind !== 'release') sink.decision = decision
      this.finish(entry, decision.kind === 'release' ? 'released' : 'answered')
      return true
    }
    if (prompt.hook === 'PreToolUse' && decision.kind === 'allow') {
      this.preApproved.set(this.key(prompt.tabId, prompt.toolName), Date.now() + PRE_APPROVAL_MS)
    }
    this.write(sink.res, decisionBody(prompt.hook as Exclude<DecidingHook, 'mod'>, decision))
    this.finish(entry, decision.kind === 'release' ? 'released' : 'answered')
    return true
  }

  /** Hand every held prompt back to the terminal (we're quitting). */
  releaseAll(outcome: PromptOutcome = 'released'): void {
    for (const entry of [...this.entries.values()]) this.release(entry, outcome)
  }

  releaseTab(tabId: TabId): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.prompt.tabId === tabId) this.release(entry, 'released')
    }
  }

  pending(): PendingPrompt[] {
    return [...this.entries.values()].filter((e) => !e.done).map((e) => e.prompt)
  }

  forTab(tabId: TabId): PendingPrompt[] {
    return this.pending().filter((p) => p.tabId === tabId)
  }

  private promptFor(
    tabId: TabId,
    p: {
      hook: DecidingHook
      sessionId: string | null
      toolName: string
      input: Record<string, unknown>
    }
  ): PendingPrompt {
    const kind = promptKind(p.toolName)
    return {
      id: randomUUID(),
      tabId,
      sessionId: p.sessionId,
      hook: p.hook,
      kind,
      toolName: p.toolName,
      summary: promptSummary(p.toolName, p.input),
      questions: kind === 'question' ? questionsOf(p.input) : null,
      plan: kind === 'plan' && typeof p.input.plan === 'string' ? p.input.plan : null,
      planFilePath:
        kind === 'plan' && typeof p.input.planFilePath === 'string' ? p.input.planFilePath : null,
      toolInput: p.input,
      suggestedRule: suggestRule(p.toolName, p.input),
      createdAt: Date.now()
    }
  }

  /** Just before the CLI would give up on the hook. A permission is denied with
   *  the reason the mod re-asks on; anything else goes back to the terminal. */
  private expire(entry: Entry): void {
    if (entry.done || entry.sink.type !== 'hook') return
    const body =
      entry.prompt.hook === 'PermissionRequest'
        ? JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'deny', message: EXPIRED_REASON }
            }
          })
        : null
    this.write(entry.sink.res, body)
    this.finish(entry, 'expired')
  }

  private release(entry: Entry, outcome: PromptOutcome): void {
    if (entry.sink.type === 'hook') this.write(entry.sink.res, null)
    this.finish(entry, outcome)
  }

  private takeModDecision(entry: Entry): ModWait {
    const sink = entry.sink as Extract<Sink, { type: 'mod' }>
    const decision = sink.decision as PromptDecision
    sink.decision = null
    this.entries.delete(entry.prompt.id)
    return { decision }
  }

  private key(tabId: TabId, toolName: string): string {
    return `${tabId}:${toolName}`
  }

  private takePreApproval(tabId: TabId, toolName: string): boolean {
    const key = this.key(tabId, toolName)
    const until = this.preApproved.get(key)
    if (until === undefined) return false
    this.preApproved.delete(key)
    return until > Date.now()
  }

  private takeApprovedOnce(key: string): boolean {
    const until = this.approvedOnce.get(key)
    if (until === undefined) return false
    this.approvedOnce.delete(key)
    return until > Date.now()
  }

  private write(res: ParkedResponse, body: string | null): void {
    if (res.writableEnded) return
    try {
      res.writeHead(200, JSON_HEADERS)
      // an empty JSON object is "no decision" — the session's own dialog decides
      res.end(body ?? '{}')
    } catch {
      /* the CLI hung up mid-write; the prompt falls back to the terminal */
    }
  }

  private finish(entry: Entry, outcome: PromptOutcome): void {
    if (entry.done) return
    entry.done = true
    if (entry.sink.type === 'hook' && entry.sink.expiry) clearTimeout(entry.sink.expiry)
    // A decided mod entry stays until its poll collects the answer.
    if (!(entry.sink.type === 'mod' && entry.sink.decision)) this.entries.delete(entry.prompt.id)
    else setTimeout(() => this.entries.delete(entry.prompt.id), MOD_POLL_MS * 3).unref?.()
    if (entry.sink.type === 'mod') for (const wake of [...entry.sink.waiters]) wake()
    this.onResolved(entry.prompt, outcome)
  }
}
