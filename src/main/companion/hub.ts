import { basename } from 'path'
import type { ClientFrame, CompanionSession } from 'claude-term-protocol'
import type { TabId, TabStatus } from '../../shared/types'
import { addAllowRule } from './allow-rule'
import type { ConversationFeed } from './conversation-feed'
import type { Notifier } from './notifier'
import type { PushSender, PushTarget } from './push-sender'
import type { ParkedPrompts } from './parked-prompts'
import { tabCanTakeInput, type PromptQueue } from './prompt-queue'
import type { CompanionServer } from './server'

/** How often a followed conversation is checked for new turns. A poll is a stat
 *  plus a tail read of whatever bytes were appended, so this is cheap. */
export const FEED_POLL_MS = 1_000

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
  feed: ConversationFeed
  queue: PromptQueue
  notifier: Notifier
  push: PushSender
  /** Every paired device that has given us a push token — connected or not. */
  pushTargets: () => PushTarget[]
  snapshots: () => TabStatus[]
  snapshot: (tabId: TabId) => TabStatus | null
  /** Add a permission rule to the project's Claude Code settings. */
  addRule?: (cwd: string, rule: string) => boolean
  /** The tab's visible terminal rows, or null if the renderer did not answer. */
  screen: (tabId: TabId) => Promise<string[] | null>
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
  private pollTimer: NodeJS.Timeout | null = null

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
    server.onGone = (deviceId) => {
      this.deps.feed.unsubscribe(deviceId)
      this.stopPollingIfIdle()
    }
    server.onFrame = (deviceId, frame) => this.handle(deviceId, frame)

    const { queue } = this.deps
    queue.onQueued = (tabId, position) =>
      server.broadcast({ type: 'submitQueued', tabId, position })
    queue.onDelivered = (tabId) => server.broadcast({ type: 'submitDelivered', tabId })
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** Only run the timer while someone is actually following a conversation. */
  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.pushDeltas(), FEED_POLL_MS)
    // never hold the process open on account of a feed
    this.pollTimer.unref?.()
  }

  private stopPollingIfIdle(): void {
    if (this.deps.feed.active() > 0 || !this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** Exposed for tests; the timer calls this. */
  pushDeltas(): void {
    for (const delta of this.deps.feed.poll()) {
      this.deps.server.sendTo(
        delta.deviceId,
        delta.reset
          ? {
              type: 'conversation',
              tabId: delta.tabId,
              turns: delta.turns,
              cursor: delta.cursor,
              before: delta.before
            }
          : {
              type: 'conversationDelta',
              tabId: delta.tabId,
              turns: delta.turns,
              cursor: delta.cursor
            }
      )
    }
  }

  /** A tab changed — push just that session rather than the whole list. */
  publishStatus(status: TabStatus): void {
    this.deps.onChanged?.()
    // A dialog that just closed is the moment anything held becomes deliverable.
    if (tabCanTakeInput(status.activity)) this.deps.queue.flush(status.tabId)
    this.maybeNotify(status)
    this.deps.server.broadcast({
      type: 'session',
      session: toSession(status, this.promptIds(status.tabId))
    })
  }

  sessionList(): CompanionSession[] {
    return this.deps.snapshots().map((status) => toSession(status, this.promptIds(status.tabId)))
  }

  /**
   * Tell phones that are not already watching this tab.
   *
   * Targets come from the paired-device registry, NOT from the live sockets: a
   * socket only exists while the app is running, and a phone whose app is shut
   * is exactly who a push is for. Drawing them from the connections meant the
   * only device ever notified was one with the app open but looking elsewhere.
   * A device with the session itself on screen is skipped — it already knows.
   */
  private maybeNotify(status: TabStatus): void {
    const notice = this.deps.notifier.consider(status)
    if (!notice) return
    const watching = this.deps.server.attentiveDevices(status.tabId)
    // A device with no token has notifications turned off; nothing to do.
    const targets = this.deps.pushTargets().filter((t) => !watching.has(t.deviceId))
    if (targets.length === 0) return
    void this.deps.push.send(targets, notice)
  }

  /** Persist the rule a prompt suggested, and say what happened. */
  private remember(deviceId: string, promptId: string): void {
    const prompt = this.deps.parked.pending().find((p) => p.id === promptId)
    if (!prompt?.suggestedRule) return
    const cwd = this.deps.snapshot(prompt.tabId)?.cwd
    if (!cwd) return
    const added = (this.deps.addRule ?? addAllowRule)(cwd, prompt.suggestedRule)
    this.deps.server.sendTo(deviceId, {
      type: 'ruleAdded',
      tabId: prompt.tabId,
      rule: prompt.suggestedRule,
      added
    })
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
        // "allow and stop asking" writes the rule first: if the write fails the
        // device still gets its approval, just without the rule.
        if (frame.decision.kind === 'allow' && frame.decision.remember) {
          this.remember(deviceId, frame.promptId)
        }
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

      case 'subscribe': {
        const status = this.deps.snapshot(frame.tabId)
        if (!status) {
          server.sendTo(deviceId, {
            type: 'error',
            code: 'no-such-session',
            message: 'no such tab'
          })
          return
        }
        const win = this.deps.feed.subscribe(deviceId, frame.tabId)
        this.startPolling()
        if (win) {
          server.sendTo(deviceId, {
            type: 'conversation',
            tabId: frame.tabId,
            turns: win.turns,
            cursor: win.cursor,
            before: win.before
          })
        } else {
          // Following it anyway — the transcript appears once the session speaks.
          server.sendTo(deviceId, {
            type: 'error',
            code: 'no-transcript',
            message: 'nothing written yet; following it'
          })
        }
        return
      }

      case 'unsubscribe':
        this.deps.feed.unsubscribe(deviceId)
        this.stopPollingIfIdle()
        return

      case 'screen': {
        const status = this.deps.snapshot(frame.tabId)
        if (!status) {
          server.sendTo(deviceId, {
            type: 'error',
            code: 'no-such-session',
            message: 'no such tab'
          })
          return
        }
        void this.deps.screen(frame.tabId).then((rows) => {
          if (!rows) {
            // The window is closed or busy; a snapshot only exists in the UI.
            server.sendTo(deviceId, {
              type: 'error',
              code: 'no-screen',
              message: 'the app did not answer with a screen'
            })
            return
          }
          server.sendTo(deviceId, {
            type: 'screen',
            tabId: frame.tabId,
            rows,
            at: Date.now()
          })
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
        this.deps.queue.submit(frame.tabId, frame.text)
        return
      }

      default:
        return
    }
  }
}
