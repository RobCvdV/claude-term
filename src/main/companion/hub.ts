import { basename } from 'path'
import type { ClientFrame, CompanionSession } from '../../shared/companion'
import type { TabId, TabStatus } from '../../shared/types'
import type { ParkedPrompts } from './parked-prompts'
import type { CompanionServer } from './server'

/** Project a tab's status into what a phone needs to render a list row. */
export function toSession(status: TabStatus, pendingPromptIds: string[]): CompanionSession {
  return {
    tabId: status.tabId,
    sessionId: status.sessionId,
    folder: basename(status.payload?.workspace?.current_dir ?? status.cwd) || status.cwd,
    cwd: status.cwd,
    activity: status.activity,
    busySince: status.busySince,
    claudeActive: status.claudeActive,
    branch: status.git?.branch ?? null,
    model: status.payload?.model?.display_name ?? null,
    pendingPromptIds
  }
}

export interface CompanionHubDeps {
  server: CompanionServer
  parked: ParkedPrompts
  snapshots: () => TabStatus[]
  snapshot: (tabId: TabId) => TabStatus | null
  /** The app's own prompt-box path — bracketed paste, then Enter. */
  injectPrompt: (tabId: TabId, text: string) => void
  /** Anything that changes whether a device is waiting on live work. */
  onChanged?: () => void
}

/**
 * Joins the transport to the app: which sessions exist, which prompts are held,
 * and what a device is allowed to do about either.
 *
 * Prompts are only parked while a device is actually connected. That is not a
 * safety requirement — the session's own dialog is always on screen — but
 * holding a decision nobody is looking at just makes the session wait for
 * nothing.
 */
export class CompanionHub {
  constructor(private readonly deps: CompanionHubDeps) {}

  start(): void {
    const { server, parked } = this.deps

    parked.canPark = () => server.authenticatedCount() > 0
    parked.onParked = (prompt) => server.broadcast({ type: 'prompt', prompt })
    parked.onResolved = (prompt, outcome) =>
      server.broadcast({
        type: 'promptResolved',
        promptId: prompt.id,
        tabId: prompt.tabId,
        outcome
      })

    server.onPresence = (count) => {
      // The last device just left; a prompt held for it can no longer be
      // answered there, so hand it back rather than leaving the session waiting.
      if (count === 0) parked.releaseAll('released')
      this.deps.onChanged?.()
    }
    server.onFrame = (deviceId, frame) => this.handle(deviceId, frame)
  }

  /** A tab changed — push just that session rather than the whole list. */
  publishStatus(status: TabStatus): void {
    this.deps.onChanged?.()
    this.deps.server.broadcast({
      type: 'session',
      session: toSession(status, this.promptIds(status.tabId))
    })
  }

  sessionList(): CompanionSession[] {
    return this.deps.snapshots().map((status) => toSession(status, this.promptIds(status.tabId)))
  }

  private promptIds(tabId: TabId): string[] {
    return this.deps.parked.forTab(tabId).map((p) => p.id)
  }

  private handle(deviceId: string, frame: ClientFrame): void {
    const { server, parked } = this.deps
    switch (frame.type) {
      case 'sessions':
        server.sendTo(deviceId, { type: 'sessions', sessions: this.sessionList() })
        return

      case 'decide': {
        if (parked.decide(frame.promptId, frame.decision)) return
        // Either it was already answered — commonly in the terminal, a moment
        // before this arrived — or this hook cannot carry that kind of answer.
        const known = parked.pending().some((p) => p.id === frame.promptId)
        server.sendTo(deviceId, {
          type: 'error',
          code: known ? 'undeliverable' : 'no-such-prompt',
          message: known
            ? 'that prompt cannot carry this kind of answer'
            : 'that prompt is no longer waiting'
        })
        return
      }

      case 'submit': {
        const status = this.deps.snapshot(frame.tabId)
        if (!status || !status.claudeActive) {
          server.sendTo(deviceId, {
            type: 'error',
            code: 'no-such-session',
            message: 'no live Claude session in that tab'
          })
          return
        }
        this.deps.injectPrompt(frame.tabId, frame.text)
        return
      }

      default:
        return
    }
  }
}
