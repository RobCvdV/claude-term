import {
  DeviceFarmClient,
  ListProjectsCommand,
  ListRunsCommand,
  type Run
} from '@aws-sdk/client-device-farm'
import type { E2eRun, GitInfo, TabId, TabStatus } from '../shared/types'
import { DF_REGION, latestRuns, projectOf } from './devicefarm-data'
import { loginShellEnv } from './shell-env'

/**
 * Background poller for e2e runs on AWS Device Farm. A repo takes part when a
 * Device Farm project carries its repo's name (any checkout of it); its branch picks the runs.
 * One listing per project per sweep, shared by every tab on it.
 */

const POLL_MS = 60_000
const RUNNING_POLL_MS = 20_000
const ERROR_BACKOFF_MS = 2 * 60_000
const PROJECTS_TTL_MS = 60 * 60_000
/** Runs come newest first. A quick look reads the newest pages and merges
 *  them in; now and then a deep one reaches further back. */
const QUICK_PAGES = 2
const DEEP_PAGES = 6
const DEEP_EVERY_MS = 10 * 60_000
const MAX_AGE_MS = 14 * 24 * 60 * 60_000

/** AWS keys from the login shell, as the other integrations read theirs. */
export async function deviceFarmCreds(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
} | null> {
  const env = await loginShellEnv()
  const accessKeyId = env['AWS_ACCESS_KEY_ID']
  const secretAccessKey = env['AWS_SECRET_ACCESS_KEY']
  if (!accessKeyId || !secretAccessKey) return null
  const sessionToken = env['AWS_SESSION_TOKEN']
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
}

interface Listing {
  /** by ARN */
  runs: Map<string, Run>
  fetchedAt: number
  deepAt: number
  failed: boolean
  /** a run of it was still going at the last look */
  active: boolean
}

export class E2ePoller {
  private timer: NodeJS.Timeout | null = null
  private client: DeviceFarmClient | null = null
  private projects: { arns: Map<string, string>; at: number } | null = null
  private listings = new Map<string, Listing>()
  private sweeping = false

  constructor(
    private readonly getSnapshots: () => TabStatus[],
    /** `root` is null for the tab's own repo, else the extra workspace folder */
    private readonly setE2e: (tabId: TabId, root: string | null, runs: E2eRun[]) => void,
    private readonly isActive: () => boolean,
    private readonly isEnabled: () => boolean
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), RUNNING_POLL_MS)
    setTimeout(() => void this.sweep(), 6_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private clearAll(): void {
    for (const snap of this.getSnapshots()) {
      this.setE2e(snap.tabId, null, [])
      for (const r of snap.extraRepos) this.setE2e(snap.tabId, r.root, [])
    }
    this.listings.clear()
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return
    if (!this.isEnabled()) return this.clearAll()
    if (!this.isActive()) return
    this.sweeping = true
    try {
      const client = await this.clientFor()
      if (!client) return this.clearAll()
      const projects = await this.projectArns(client)
      const wanted: Array<{ tabId: TabId; root: string | null; project: string; branch: string }> =
        []
      for (const snap of this.getSnapshots()) {
        const repos: Array<{ root: string | null; cwd: string; git: GitInfo | null }> = [
          { root: null, cwd: snap.cwd, git: snap.git },
          ...snap.extraRepos.map((r) => ({ root: r.root, cwd: r.root, git: r.git }))
        ]
        for (const { root, cwd, git } of repos) {
          const project = projectOf(cwd, git?.remoteUrl)
          if (git?.branch && projects.has(project)) {
            wanted.push({ tabId: snap.tabId, root, project, branch: git.branch })
          } else {
            this.setE2e(snap.tabId, root, [])
          }
        }
      }
      for (const project of new Set(wanted.map((w) => w.project))) {
        await this.refresh(client, project, projects.get(project)!)
      }
      for (const { tabId, root, project, branch } of wanted) {
        const listing = this.listings.get(project)
        if (listing) this.setE2e(tabId, root, latestRuns([...listing.runs.values()], branch))
      }
    } finally {
      this.sweeping = false
    }
  }

  private async clientFor(): Promise<DeviceFarmClient | null> {
    if (this.client) return this.client
    const credentials = await deviceFarmCreds()
    if (!credentials) return null
    this.client = new DeviceFarmClient({ region: DF_REGION, credentials })
    return this.client
  }

  /** Project name → ARN; project names are the repo names. */
  private async projectArns(client: DeviceFarmClient): Promise<Map<string, string>> {
    if (this.projects && Date.now() - this.projects.at < PROJECTS_TTL_MS) return this.projects.arns
    const arns = new Map<string, string>()
    try {
      let nextToken: string | undefined
      do {
        const page = await client.send(new ListProjectsCommand({ nextToken }))
        for (const p of page.projects ?? []) if (p.name && p.arn) arns.set(p.name, p.arn)
        nextToken = page.nextToken
      } while (nextToken)
      this.projects = { arns, at: Date.now() }
    } catch {
      // keys without Device Farm rights, or offline: try again after the backoff
      this.projects = { arns, at: Date.now() - PROJECTS_TTL_MS + ERROR_BACKOFF_MS }
    }
    return arns
  }

  private async refresh(client: DeviceFarmClient, project: string, arn: string): Promise<void> {
    const have = this.listings.get(project)
    const ttl = have?.failed
      ? ERROR_BACKOFF_MS
      : have?.active
        ? RUNNING_POLL_MS - 2_000
        : POLL_MS - 5_000
    const now = Date.now()
    if (have && now - have.fetchedAt < ttl) return
    const deep = !have || now - have.deepAt > DEEP_EVERY_MS
    const runs = new Map(deep ? [] : have.runs)
    try {
      let nextToken: string | undefined
      for (let page = 0; page < (deep ? DEEP_PAGES : QUICK_PAGES); page++) {
        const res = await client.send(new ListRunsCommand({ arn, nextToken }))
        for (const r of res.runs ?? []) if (r.arn) runs.set(r.arn, r)
        nextToken = res.nextToken
        const oldest = res.runs?.at(-1)?.created?.getTime() ?? 0
        if (!nextToken || now - oldest > MAX_AGE_MS) break
      }
      for (const [key, r] of runs) {
        if (now - (r.created?.getTime() ?? 0) > MAX_AGE_MS) runs.delete(key)
      }
      const active = [...runs.values()].some((r) => r.status !== 'COMPLETED')
      this.listings.set(project, {
        runs,
        fetchedAt: now,
        deepAt: deep ? now : have!.deepAt,
        failed: false,
        active
      })
    } catch {
      // keep what we had; only the timing changes
      this.listings.set(project, {
        runs: have?.runs ?? new Map(),
        fetchedAt: now,
        deepAt: have?.deepAt ?? 0,
        failed: true,
        active: false
      })
    }
  }
}
