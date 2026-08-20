import { randomUUID } from 'crypto'
import type { TabId } from '../shared/types'

/** A screen snapshot lives in the renderer's xterm, so asking costs a round
 *  trip. If it does not come back promptly the renderer is busy or gone. */
export const SCREEN_TIMEOUT_MS = 1_500

interface Pending {
  resolve: (rows: string[] | null) => void
  timer: NodeJS.Timeout
}

/**
 * Request/response over the otherwise fire-and-forget main→renderer channel.
 *
 * Only the renderer's terminal knows what is on a tab's screen, and main has no
 * way to ask for something and be answered — `webContents.send` is one-way. This
 * pairs a request id with the reply that comes back on a separate channel, and
 * gives up rather than hanging if no reply arrives.
 */
export class ScreenRequests {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly ask: (requestId: string, tabId: TabId) => void,
    private readonly timeoutMs = SCREEN_TIMEOUT_MS
  ) {}

  /** The tab's visible rows, or null if the renderer did not answer. */
  request(tabId: TabId): Promise<string[] | null> {
    const requestId = randomUUID()
    return new Promise<string[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(null)
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { resolve, timer })
      try {
        this.ask(requestId, tabId)
      } catch {
        // no window to ask — settle now rather than waiting out the timeout
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(null)
      }
    })
  }

  /** Called with whatever the renderer sent back. Late or unknown ids are ignored. */
  resolve(requestId: string, rows: string[]): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve(rows)
  }

  /** Answer everything outstanding with nothing — the window is going away. */
  abandonAll(): void {
    for (const [id, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.resolve(null)
    }
  }

  outstanding(): number {
    return this.pending.size
  }
}
