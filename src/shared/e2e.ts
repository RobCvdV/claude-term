import type { E2eRun, E2eState } from './types'

/** All of a branch's e2e groups as one: what the status bar chip shows. */
export interface E2eSummary {
  /** failed wins, then running, then queued; passed only when all passed */
  state: E2eState
  /** device jobs done over all groups, 0–100 */
  progress: number
  /** groups finished (passed, failed or stopped) */
  done: number
  total: number
  /** groups that failed, by name */
  failedGroups: string[]
}

const FINISHED: E2eState[] = ['passed', 'failed', 'stopped']

export function e2eSummary(runs: E2eRun[]): E2eSummary | null {
  if (!runs.length) return null
  const has = (s: E2eState): boolean => runs.some((r) => r.state === s)
  const state: E2eState = has('failed')
    ? 'failed'
    : has('running')
      ? 'running'
      : has('queued')
        ? 'queued'
        : has('stopped')
          ? 'stopped'
          : 'passed'
  const jobsTotal = runs.reduce((n, r) => n + r.jobsTotal, 0)
  const jobsDone = runs.reduce((n, r) => n + r.jobsDone, 0)
  return {
    state,
    progress: jobsTotal ? Math.round((jobsDone / jobsTotal) * 100) : 0,
    done: runs.filter((r) => FINISHED.includes(r.state)).length,
    total: runs.length,
    failedGroups: runs.filter((r) => r.state === 'failed').map((r) => r.group)
  }
}

/** Still going: the chip pulses and polling stays quick. */
export const e2eActive = (s: E2eState): boolean => s === 'running' || s === 'queued'
