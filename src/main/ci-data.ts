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
