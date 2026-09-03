import { CONVERSATION_WINDOW, MAX_TURN_CHARS, type ConversationTurn } from 'claude-term-protocol'
import type { TabId } from '../../shared/types'
import type { ConvoTurn } from '../transcript-search'

/**
 * A device following one session's conversation.
 *
 * The conversation is read from the session's transcript, not from the terminal:
 * Claude Code draws on the alternate screen buffer, which keeps no scrollback, so
 * the terminal simply does not have the history. Turns are append-only, which
 * makes an index into them a stable cursor — a poll costs a tail read of the
 * bytes added since last time, shared with the cache ⌘F already fills.
 */
export interface Subscription {
  tabId: TabId
  /** the session whose transcript we are following; null until one exists */
  sessionId: string | null
  /** how many turns this device has already been sent */
  cursor: number
}

export interface FeedWindow {
  turns: ConversationTurn[]
  cursor: number
  /** turns older than the window, so a client can say "earlier history exists" */
  before: number
}

export interface FeedDelta {
  deviceId: string
  tabId: TabId
  turns: ConversationTurn[]
  cursor: number
  /** the transcript restarted (new session, or rewritten) — replace, don't append */
  reset: boolean
  before: number
}

/** Trim a parsed turn down to what is worth putting on a phone. */
export function toTurn(turn: ConvoTurn): ConversationTurn {
  const text =
    turn.text.length > MAX_TURN_CHARS ? `${turn.text.slice(0, MAX_TURN_CHARS)}…` : turn.text
  return {
    role: turn.role,
    ...(turn.tool ? { tool: turn.tool } : {}),
    time: turn.time,
    text
  }
}

export function windowOf(turns: readonly ConvoTurn[], size = CONVERSATION_WINDOW): FeedWindow {
  const from = Math.max(0, turns.length - size)
  return {
    turns: turns.slice(from).map(toTurn),
    cursor: turns.length,
    before: from
  }
}

export interface ConversationFeedDeps {
  /** Parsed turns for a session, or null when it has no transcript yet. */
  turnsFor: (sessionId: string) => readonly ConvoTurn[] | null
  /** Which Claude session a tab is currently hosting. */
  sessionOf: (tabId: TabId) => string | null
}

export class ConversationFeed {
  private subs = new Map<string, Subscription>()

  constructor(private readonly deps: ConversationFeedDeps) {}

  /** One subscription per device; subscribing again moves it to another tab. */
  subscribe(deviceId: string, tabId: TabId): FeedWindow | null {
    const sessionId = this.deps.sessionOf(tabId)
    const turns = sessionId ? this.deps.turnsFor(sessionId) : null
    if (!turns) {
      // Remember it anyway: a tab whose session has not written a transcript yet
      // will start producing one, and the poll picks it up.
      this.subs.set(deviceId, { tabId, sessionId, cursor: 0 })
      return null
    }
    const win = windowOf(turns)
    this.subs.set(deviceId, { tabId, sessionId, cursor: win.cursor })
    return win
  }

  unsubscribe(deviceId: string): void {
    this.subs.delete(deviceId)
  }

  subscriptionOf(deviceId: string): Subscription | null {
    return this.subs.get(deviceId) ?? null
  }

  active(): number {
    return this.subs.size
  }

  /**
   * What each subscriber has not seen yet. Called on a timer while anyone is
   * subscribed; returns nothing when nothing moved, so an idle session costs a
   * stat per subscriber.
   */
  poll(): FeedDelta[] {
    const out: FeedDelta[] = []
    for (const [deviceId, sub] of this.subs) {
      const sessionId = this.deps.sessionOf(sub.tabId)
      // The tab restarted its session, or acquired one since we subscribed.
      const restarted = sessionId !== sub.sessionId
      if (restarted) {
        sub.sessionId = sessionId
        sub.cursor = 0
      }
      if (!sessionId) continue
      const turns = this.deps.turnsFor(sessionId)
      if (!turns) continue
      // A shrunk transcript means it was rewritten; start over rather than
      // slicing from a cursor that no longer means anything.
      if (turns.length < sub.cursor) {
        sub.cursor = 0
      } else if (turns.length === sub.cursor && !restarted) {
        continue
      }
      const fresh = sub.cursor === 0
      const win = fresh
        ? windowOf(turns)
        : { turns: turns.slice(sub.cursor).map(toTurn), cursor: turns.length, before: 0 }
      if (win.turns.length === 0 && !restarted) continue
      sub.cursor = win.cursor
      out.push({
        deviceId,
        tabId: sub.tabId,
        turns: win.turns,
        cursor: win.cursor,
        reset: fresh,
        before: win.before
      })
    }
    return out
  }
}
