import type { ActivityState } from '../shared/types'

/** How recent a transcript write still counts as "working". Writes pause
 *  during long silent tool runs, so this errs on the long side. */
export const BUSY_WINDOW_MS = 15_000

/**
 * Synthetic activity for a tab hosting an attached background agent. Its
 * hooks/statusline POST to the endpoint of the app run that launched it, so
 * no live feed arrives — instead: the daemon marks a job waiting for input as
 * `blocked`, and a transcript that was written to just now means a turn is
 * running.
 */
export function attachedActivity(input: {
  /** transcript mtime, epoch ms; null when the transcript isn't found */
  transcriptMtime: number | null
  /** `state` from the job's state.json; null when unknown */
  jobState: string | null
  now: number
}): ActivityState {
  if (input.jobState === 'blocked') return 'needs-attention'
  if (input.transcriptMtime !== null && input.now - input.transcriptMtime < BUSY_WINDOW_MS) {
    return 'busy'
  }
  return 'idle'
}
