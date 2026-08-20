import { basename } from 'path'
import type { ActivityState, TabId, TabStatus } from '../../shared/types'

/**
 * Decides what is worth interrupting someone for.
 *
 * Bodies are deliberately vague. A push travels through Expo and Apple, so the
 * command being asked about, the file being edited and the project path stay on
 * the tailnet — the phone fetches the detail once it is opened.
 */
export type PushKind = 'needs-attention' | 'idle' | 'exited'

export interface PushNotice {
  tabId: TabId
  kind: PushKind
  title: string
  /** the folder, and nothing more revealing than that */
  body: string
  /** what the phone opens when tapped */
  data: { tabId: TabId; kind: PushKind }
}

/** A turn shorter than this finished before anyone walked away from it. */
export const MIN_TURN_FOR_IDLE_MS = 30_000
/** The same tab cannot ping twice inside this window, whatever happened. */
export const PER_TAB_COOLDOWN_MS = 10_000

interface Seen {
  activity: ActivityState
  busySince: number | null
  lastPushAt: number
}

const TITLES: Record<PushKind, string> = {
  'needs-attention': 'Claude needs your input',
  idle: 'Claude finished',
  exited: 'Session ended'
}

export interface NotifierDeps {
  /** True while the user is at the desk with the app in front of them. */
  hostFocused: () => boolean
  now?: () => number
}

export class Notifier {
  private seen = new Map<TabId, Seen>()

  constructor(private readonly deps: NotifierDeps) {}

  /**
   * What (if anything) this status change is worth telling a phone. Called for
   * every status update, so it has to be cheap and quiet.
   */
  consider(status: TabStatus): PushNotice | null {
    const now = this.deps.now?.() ?? Date.now()
    const previous = this.seen.get(status.tabId)
    // Remember the state before deciding, so an early return still updates it.
    this.seen.set(status.tabId, {
      activity: status.activity,
      // busySince is cleared on the way out of busy, so carry the old one over
      busySince: status.busySince ?? (status.activity === 'busy' ? now : null),
      lastPushAt: previous?.lastPushAt ?? 0
    })
    if (!previous || previous.activity === status.activity) return null

    const kind = this.kindFor(previous, status)
    if (!kind) return null
    // Someone sitting in front of the app does not need their phone to buzz.
    if (this.deps.hostFocused()) return null
    if (now - (previous.lastPushAt ?? 0) < PER_TAB_COOLDOWN_MS) return null

    this.seen.set(status.tabId, { ...this.seen.get(status.tabId)!, lastPushAt: now })
    const folder = basename(status.payload?.workspace?.current_dir ?? status.cwd) || status.cwd
    return {
      tabId: status.tabId,
      kind,
      title: TITLES[kind],
      body: folder,
      data: { tabId: status.tabId, kind }
    }
  }

  /** Stop tracking a tab that has gone. */
  forget(tabId: TabId): void {
    this.seen.delete(tabId)
  }

  private kindFor(previous: Seen, status: TabStatus): PushKind | null {
    if (status.activity === 'needs-attention') return 'needs-attention'
    if (status.activity === 'exited' || status.activity === 'ended') return 'exited'
    if (status.activity === 'idle' && previous.activity === 'busy') {
      // A quick turn finished while its author was still watching.
      const ran = previous.busySince ? (this.deps.now?.() ?? Date.now()) - previous.busySince : 0
      return ran >= MIN_TURN_FOR_IDLE_MS ? 'idle' : null
    }
    return null
  }
}
