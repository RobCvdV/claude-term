import type { ActivityState, TabId } from '../../shared/types'

/**
 * Prompts a device sent, waiting for a moment when the session can take them.
 *
 * The hazard is not a busy session — Claude Code queues typed input perfectly
 * well mid-turn — it is a session sitting on a dialog. A permission prompt or a
 * picker owns the keyboard, so pasting a prompt into it would answer the dialog
 * instead of asking a question. So a prompt is held while the tab needs
 * attention, and delivered as soon as it does not.
 */
export interface QueuedPrompt {
  tabId: TabId
  text: string
}

export interface PromptQueueDeps {
  /** The app's bracketed-paste injection path. */
  deliver: (tabId: TabId, text: string) => void
  /** Can this tab take input right now? */
  ready: (tabId: TabId) => boolean
}

export class PromptQueue {
  private waiting: QueuedPrompt[] = []

  /** Set by the hub: a prompt was held rather than delivered. */
  onQueued: (tabId: TabId, position: number) => void = () => {}
  /** Set by the hub: a held prompt has now gone through. */
  onDelivered: (tabId: TabId, text: string) => void = () => {}

  constructor(private readonly deps: PromptQueueDeps) {}

  /**
   * Deliver now if the tab can take it, otherwise hold it. Returns the queue
   * position, or 0 when it went straight through.
   */
  submit(tabId: TabId, text: string): number {
    if (this.deps.ready(tabId) && !this.waiting.some((p) => p.tabId === tabId)) {
      this.deps.deliver(tabId, text)
      return 0
    }
    this.waiting.push({ tabId, text })
    const position = this.waiting.filter((p) => p.tabId === tabId).length
    this.onQueued(tabId, position)
    return position
  }

  /** A tab's state changed; send anything that was waiting on it. */
  flush(tabId: TabId): void {
    while (this.deps.ready(tabId)) {
      const next = this.waiting.findIndex((p) => p.tabId === tabId)
      if (next === -1) return
      const [prompt] = this.waiting.splice(next, 1)
      this.deps.deliver(prompt.tabId, prompt.text)
      this.onDelivered(prompt.tabId, prompt.text)
    }
  }

  /** Nothing queued for a tab that is going away can ever be delivered. */
  forget(tabId: TabId): void {
    this.waiting = this.waiting.filter((p) => p.tabId !== tabId)
  }

  pending(tabId?: TabId): number {
    return tabId ? this.waiting.filter((p) => p.tabId === tabId).length : this.waiting.length
  }
}

/** A dialog owns the keyboard, so anything typed would answer it instead. */
export function tabCanTakeInput(activity: ActivityState | undefined): boolean {
  return activity !== undefined && activity !== 'needs-attention'
}
