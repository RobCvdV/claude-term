import type { CiState } from '../shared/types'

/** Map raw CI provider responses to a CiState. Pure, no I/O. */

/** Jenkins `lastBuild/api/json`. */
export function jenkinsCiState(body: { building?: boolean; result?: string | null }): CiState {
  if (body.building) return 'running'
  switch (body.result) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'UNSTABLE':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** `gh run list --json status,conclusion` (newest run first). */
export function actionsCiState(runs: { status?: string; conclusion?: string | null }[]): CiState {
  const run = runs[0]
  if (!run) return 'unknown'
  if (run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting') {
    return 'running'
  }
  switch (run.conclusion) {
    case 'success':
      return 'success'
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** CircleCI v2 workflows of the branch's newest pipeline. */
export function circleCiCiState(workflows: { status?: string }[]): CiState {
  if (workflows.length === 0) return 'unknown'
  const statuses = workflows.map((w) => w.status)
  if (statuses.some((s) => s === 'running' || s === 'on_hold')) return 'running'
  if (statuses.some((s) => s === 'failed' || s === 'error' || s === 'failing')) return 'failed'
  if (statuses.every((s) => s === 'success')) return 'success'
  return 'unknown'
}

/** Time-based estimate from Jenkins' own expected duration; capped below 100
 *  so an overrunning build never reads as done. */
export function jenkinsProgress(
  body: { building?: boolean; timestamp?: number; estimatedDuration?: number },
  now: number
): number | undefined {
  if (!body.building || !body.timestamp || !body.estimatedDuration || body.estimatedDuration <= 0) {
    return undefined
  }
  const pct = Math.floor(((now - body.timestamp) / body.estimatedDuration) * 100)
  return Math.max(0, Math.min(99, pct))
}

/** Finished share of a running run's jobs, e.g. 3 of 7 → { progress: 42, detail: '3/7 jobs' }. */
export function jobProgress(
  statuses: (string | undefined)[],
  isDone: (status: string | undefined) => boolean
): { progress: number; detail: string } | undefined {
  if (statuses.length === 0) return undefined
  const done = statuses.filter(isDone).length
  return {
    progress: Math.min(99, Math.floor((done / statuses.length) * 100)),
    detail: `${done}/${statuses.length} jobs`
  }
}

const CIRCLE_PENDING = new Set(['running', 'queued', 'not_running', 'blocked', 'on_hold'])
export const circleJobDone = (s: string | undefined): boolean => !!s && !CIRCLE_PENDING.has(s)
export const actionsJobDone = (s: string | undefined): boolean => s === 'completed'
