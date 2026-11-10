/** Turning AWS Device Farm runs into a branch's e2e groups. Pure — the poller
 *  fetches, this decides. */

import { basename } from 'path'
import { parseRemote } from '../shared/repo-links'
import type { E2eRun, E2eState } from '../shared/types'

/** The fields of a Device Farm `Run` this reads. */
export interface DfRun {
  arn?: string
  name?: string
  created?: Date
  status?: string
  result?: string
  completedJobs?: number
  totalJobs?: number
  counters?: { passed?: number; failed?: number; errored?: number }
}

/** Device Farm lives in one region only. */
export const DF_REGION = 'us-west-2'

/** Run names carry this before the group on the Driver Next project. */
const NAME_PREFIX = 'mmx-next-'

/**
 * The test group and CI build of a run started for `branch`, or null for
 * another branch's run. Names are `<group>-<branch>` with an optional
 * ` #<build> <sha>` after it: `mmx-next-workingHours-feature/MTX-1-x #9409 92d7`,
 * `1-bugfix/MTX-2-y`.
 */
export function groupOf(name: string, branch: string): { group: string; build?: string } | null {
  const at = name.indexOf(`-${branch}`)
  if (at <= 0) return null
  const after = name.slice(at + 1 + branch.length)
  // `feature/x` must not claim `feature/x-2`'s runs
  if (after && !after.startsWith(' ')) return null
  let group = name.slice(0, at)
  if (group.startsWith(NAME_PREFIX)) group = group.slice(NAME_PREFIX.length)
  if (/^\d+$/.test(group)) group = `Group ${group}`
  const build = /#\d+/.exec(after)?.[0]
  return build ? { group, build } : { group }
}

/** The Device Farm project a checkout belongs to: named after its repo, so a
 *  second checkout (`mendrix-mobile-next-2`) finds the same project. The
 *  folder name stands in when there is no remote. */
export function projectOf(cwd: string, remoteUrl: string | null | undefined): string {
  return (remoteUrl && parseRemote(remoteUrl)?.repo) || basename(cwd)
}

/** Device Farm marks a run SKIPPED even when one of its tests failed, so the
 *  counters decide before the result does. */
export function runState(run: DfRun): E2eState {
  switch (run.status) {
    case 'COMPLETED':
      break
    case 'PREPARING':
    case 'RUNNING':
    case 'STOPPING':
      return 'running'
    default:
      return 'queued'
  }
  const c = run.counters ?? {}
  if ((c.failed ?? 0) + (c.errored ?? 0) > 0) return 'failed'
  if (run.result === 'FAILED' || run.result === 'ERRORED') return 'failed'
  if (run.result === 'STOPPED') return 'stopped'
  return 'passed'
}

/** The run's page in the AWS console. Its ARN ends in `<project id>/<run id>`. */
export function consoleUrl(arn: string): string {
  const [project, run] = arn.slice(arn.lastIndexOf(':') + 1).split('/')
  return (
    `https://${DF_REGION}.console.aws.amazon.com/devicefarm/home?region=${DF_REGION}` +
    `#/mobile/projects/${project}/runs/${run}`
  )
}

/** The newest run of each test group for `branch`, groups A–Z. */
export function latestRuns(runs: DfRun[], branch: string): E2eRun[] {
  const byGroup = new Map<string, E2eRun>()
  for (const run of runs) {
    if (!run.arn || !run.name) continue
    const g = groupOf(run.name, branch)
    if (!g) continue
    const created = run.created?.getTime() ?? 0
    const have = byGroup.get(g.group)
    if (have && have.created >= created) continue
    byGroup.set(g.group, {
      group: g.group,
      state: runState(run),
      jobsDone: run.completedJobs ?? 0,
      jobsTotal: run.totalJobs ?? 0,
      passed: run.counters?.passed ?? 0,
      failed: (run.counters?.failed ?? 0) + (run.counters?.errored ?? 0),
      ...(g.build ? { build: g.build } : {}),
      url: consoleUrl(run.arn),
      created
    })
  }
  return [...byGroup.values()].sort((a, b) =>
    a.group.localeCompare(b.group, undefined, { numeric: true, sensitivity: 'base' })
  )
}
