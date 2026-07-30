import type { TabStatus } from '../../shared/types'

/** What a tab was restored with — the persisted session's view of it. */
export interface RestoredSession {
  sessionId: string | null
  claudeActive: boolean
}

/**
 * The `{ sessionId, claudeActive }` half of a persisted tab: what the next
 * launch will use to decide whether (and what) to revive.
 *
 * The subtlety is a tab with no session *right now*. That means one of two very
 * different things:
 *
 *  - it never hosted one this run — a revive that didn't come up (cold daemon,
 *    transcript briefly unreadable, no `claude` on PATH), or one we downgraded
 *    to a plain shell. Persisting the absence would overwrite the id we were
 *    revived from, so a single bad launch permanently lost the conversation.
 *    Keep what we were restored with instead: next launch tries again.
 *
 *  - it hosted one and the session ended (`/exit`, SessionEnd). The id stays on
 *    the status, so that case is distinguishable — and it must persist as-is,
 *    inactive, or a session the user deliberately ended would be resurrected on
 *    every launch.
 */
export function persistedSessionOf(
  status: TabStatus | null | undefined,
  restored: RestoredSession | undefined
): RestoredSession {
  const own = status?.sessionId ?? null
  const active = !!status?.claudeActive
  if (!own && !active && restored) return { ...restored }
  return { sessionId: own, claudeActive: active }
}
