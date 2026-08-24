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
export function decisionBody(hook: DecidingHook, decision: PromptDecision): string | null {
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
export function canDeliver(hook: DecidingHook, decision: PromptDecision): boolean {
  // PermissionRequest silently discards the reason, so text answered there would
  // vanish — the model would only see "blocked by a permission hook".
  return !(hook === 'PermissionRequest' && decision.kind === 'respond')
}

function questionsOf(input: Record<string, unknown>): QuestionSpec[] | null {
  const q = input.questions
  return Array.isArray(q) ? (q as QuestionSpec[]) : null
}

interface Entry {
  prompt: PendingPrompt
  res: ParkedResponse
  done: boolean
}

/**
 * Prompts held open while a companion device decides.
 *
 * The session's own dialog is drawn immediately and in parallel, so a parked
 * prompt is always still answerable at the desk — which is why nothing here ever
 * times out or decides on the user's behalf. Exactly one of answer / release /
 * closed-by-the-CLI resolves an entry, and every path is idempotent.
 */
export class ParkedPrompts {
  private entries = new Map<string, Entry>()
  private preApproved = new Map<string, number>()

  /** Set by the companion server: is anyone actually listening for this tab? */
  canPark: (tabId: TabId) => boolean = () => false

  onParked: (prompt: PendingPrompt) => void = () => {}
  onResolved: (prompt: PendingPrompt, outcome: PromptOutcome) => void = () => {}

  /**
   * Take ownership of a hook request, if it is one we can park and someone is
   * listening. Returns true when the response is now ours to answer — the caller
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

    // A device already approved this at PreToolUse — don't ask it twice.
    if (hook === 'PermissionRequest' && this.takePreApproval(tabId, toolName)) {
      this.write(res, decisionBody('PermissionRequest', { kind: 'allow' }))
      return true
    }
    if (!this.canPark(tabId)) return false

    const prompt: PendingPrompt = {
      id: randomUUID(),
      tabId,
      sessionId: typeof evt.session_id === 'string' ? evt.session_id : null,
      hook,
      kind,
      toolName,
      summary: promptSummary(toolName, input),
      questions: kind === 'question' ? questionsOf(input) : null,
      plan: kind === 'plan' && typeof input.plan === 'string' ? input.plan : null,
      planFilePath:
        kind === 'plan' && typeof input.planFilePath === 'string' ? input.planFilePath : null,
      toolInput: input,
      suggestedRule: suggestRule(toolName, input),
      createdAt: Date.now()
    }
    const entry: Entry = { prompt, res, done: false }
    this.entries.set(prompt.id, entry)
    // The CLI closes the connection when the user answers in the terminal.
    res.on('close', () => this.finish(entry, 'terminal'))
    this.onParked(prompt)
    return true
  }

  /** Answer a parked prompt. False if it is unknown, gone, or undeliverable. */
  decide(id: string, decision: PromptDecision): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.done) return false
    if (!canDeliver(entry.prompt.hook, decision)) return false
    if (entry.prompt.hook === 'PreToolUse' && decision.kind === 'allow') {
      this.preApproved.set(
        this.key(entry.prompt.tabId, entry.prompt.toolName),
        Date.now() + PRE_APPROVAL_MS
      )
    }
    this.write(entry.res, decisionBody(entry.prompt.hook, decision))
    this.finish(entry, decision.kind === 'release' ? 'released' : 'answered')
    return true
  }

  /** Hand every held prompt back to the terminal (a device left, or we're quitting). */
  releaseAll(outcome: PromptOutcome = 'released'): void {
    for (const entry of [...this.entries.values()]) {
      this.write(entry.res, null)
      this.finish(entry, outcome)
    }
  }

  releaseTab(tabId: TabId): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.prompt.tabId !== tabId) continue
      this.write(entry.res, null)
      this.finish(entry, 'released')
    }
  }

  pending(): PendingPrompt[] {
    return [...this.entries.values()].map((e) => e.prompt)
  }

  forTab(tabId: TabId): PendingPrompt[] {
    return this.pending().filter((p) => p.tabId === tabId)
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
    this.entries.delete(entry.prompt.id)
    this.onResolved(entry.prompt, outcome)
  }
}
