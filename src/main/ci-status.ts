import { execFile } from 'child_process'
import { basename } from 'path'
import type { CiInfo, CiProvider, CiState, GitInfo, TabId, TabStatus } from '../shared/types'
import {
  actionsUrl,
  circleCiUrl,
  jenkinsJobUrl,
  parseRemote,
  type RepoRef
} from '../shared/repo-links'
import {
  actionsCiState,
  actionsJobDone,
  circleCiCiState,
  circleJobDone,
  jenkinsCiState,
  jenkinsProgress,
  jobProgress
} from './ci-data'
import { loginShellEnv } from './shell-env'

/**
 * Background CI poller: one fetch per distinct provider+repo+branch per sweep
 * (many tabs on the same branch share the answer), every ~60s while the app
 * window is visible. Results land in TabStatus.ci via the status server.
 */

const POLL_MS = 60_000
/** a running build is re-asked sooner, so its progress moves */
const RUNNING_POLL_MS = 20_000
/** hold failures longer, so a missing token / offline CI isn't hammered */
const ERROR_BACKOFF_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 10_000

/** What one fetch learns; `url` points at the build itself when known. */
interface CiResult {
  state: CiState
  url?: string
  progress?: number
  detail?: string
}

interface Target {
  key: string
  provider: CiProvider
  url: string
  fetch: () => Promise<CiResult>
}

interface Cached {
  result: CiResult
  fetchedAt: number
  failedFetch: boolean
}

export class CiPoller {
  private timer: NodeJS.Timeout | null = null
  private cache = new Map<string, Cached>()
  private sweeping = false

  constructor(
    private readonly getSnapshots: () => TabStatus[],
    /** `root` is null for the tab's own repo, else the extra workspace folder */
    private readonly setCi: (tabId: TabId, root: string | null, ci: CiInfo | null) => void,
    private readonly isActive: () => boolean,
    private readonly isEnabled: () => boolean = () => true
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), RUNNING_POLL_MS)
    setTimeout(() => void this.sweep(), 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return
    if (!this.isEnabled()) {
      // switched off: drop the dots rather than leave a stale state up
      for (const snap of this.getSnapshots()) {
        this.setCi(snap.tabId, null, null)
        for (const r of snap.extraRepos) this.setCi(snap.tabId, r.root, null)
      }
      this.cache.clear()
      return
    }
    if (!this.isActive()) return
    this.sweeping = true
    try {
      // group (tab, workspace repo) pairs by distinct CI target so each is
      // fetched once — many tabs/roots on the same repo+branch share the answer
      const jobs = new Map<
        string,
        { target: Target; tabs: Array<{ tabId: TabId; root: string | null }> }
      >()
      for (const snap of this.getSnapshots()) {
        const repos: Array<{ root: string | null; cwd: string; git: GitInfo | null }> = [
          { root: null, cwd: snap.cwd, git: snap.git },
          ...snap.extraRepos.map((r) => ({ root: r.root, cwd: r.root, git: r.git }))
        ]
        for (const { root, cwd, git } of repos) {
          const target = targetFor(cwd, git)
          if (!target) {
            this.setCi(snap.tabId, root, null)
            continue
          }
          const job = jobs.get(target.key) ?? { target, tabs: [] }
          job.tabs.push({ tabId: snap.tabId, root })
          jobs.set(target.key, job)
        }
      }
      // sequential fetches: natural stagger, and there are only a few keys
      for (const { target, tabs } of jobs.values()) {
        const cached = this.cache.get(target.key)
        const ttl = cached?.failedFetch
          ? ERROR_BACKOFF_MS
          : cached?.result.state === 'running'
            ? RUNNING_POLL_MS - 2_000
            : POLL_MS - 5_000
        if (!cached || Date.now() - cached.fetchedAt > ttl) {
          let result: CiResult = { state: 'unknown' }
          let failedFetch = false
          try {
            result = await target.fetch()
          } catch {
            failedFetch = true
          }
          this.cache.set(target.key, { result, fetchedAt: Date.now(), failedFetch })
        }
        const { state, url, progress, detail } = this.cache.get(target.key)!.result
        const ci: CiInfo | null =
          state === 'unknown'
            ? null
            : {
                provider: target.provider,
                state,
                url: url ?? target.url,
                ...(progress != null ? { progress } : {}),
                ...(detail ? { detail } : {})
              }
        for (const { tabId, root } of tabs) this.setCi(tabId, root, ci)
      }
    } finally {
      this.sweeping = false
    }
  }
}

function targetFor(cwd: string, git: GitInfo | null): Target | null {
  if (!git?.branch) return null
  const branch = git.branch
  const jenkins = jenkinsJobUrl(basename(cwd), branch)
  if (jenkins) {
    return {
      key: `jenkins:${jenkins}`,
      provider: 'jenkins',
      url: jenkins,
      fetch: () => fetchJenkins(jenkins)
    }
  }
  const repo = git.remoteUrl ? parseRemote(git.remoteUrl) : null
  if (repo?.host === 'github' && git.hasWorkflows) {
    return {
      key: `actions:${repo.owner}/${repo.repo}#${branch}`,
      provider: 'actions',
      url: actionsUrl(repo, branch) as string,
      fetch: () => fetchActions(cwd, branch)
    }
  }
  const circle = repo ? circleCiUrl(repo, branch) : null
  if (circle && repo) {
    return {
      key: `circleci:${repo.owner}/${repo.repo}#${branch}`,
      provider: 'circleci',
      url: circle,
      fetch: () => fetchCircle(repo, branch)
    }
  }
  return null
}

async function fetchJenkins(jobUrl: string): Promise<CiResult> {
  const env = await loginShellEnv()
  const headers: Record<string, string> = { Accept: 'application/json' }
  const user = env['JENKINS_USER']
  const token = env['JENKINS_API_TOKEN'] ?? env['JENKINS_TOKEN']
  if (user && token) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64')
  }
  const res = await fetch(
    `${jobUrl}lastBuild/api/json?tree=building,result,timestamp,estimatedDuration,number,url`,
    { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  )
  // no such job (e.g. a branch Jenkins never built) — nothing to show, no error
  if (res.status === 404) return { state: 'unknown' }
  if (!res.ok) throw new Error(`jenkins ${res.status}`)
  const body = (await res.json()) as {
    building?: boolean
    result?: string | null
    timestamp?: number
    estimatedDuration?: number
    number?: number
    url?: string
  }
  return {
    state: jenkinsCiState(body),
    url: body.url,
    progress: jenkinsProgress(body, Date.now()),
    detail: body.number != null ? `#${body.number}` : undefined
  }
}

function gh(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, env, timeout: FETCH_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

/** Rides the `gh` CLI's existing auth, like the PR lookups. Job counts are
 *  only asked while the run is going. */
async function fetchActions(cwd: string, branch: string): Promise<CiResult> {
  const env = await loginShellEnv()
  const out = await gh(cwd, env, [
    'run',
    'list',
    '--branch',
    branch,
    '--limit',
    '1',
    '--json',
    'status,conclusion,url,databaseId'
  ])
  if (out === null) throw new Error('gh run list failed')
  const runs = JSON.parse(out) as {
    status?: string
    conclusion?: string | null
    url?: string
    databaseId?: number
  }[]
  const state = actionsCiState(runs)
  const run = runs[0]
  const result: CiResult = { state, url: run?.url }
  if (state === 'running' && run?.databaseId != null) {
    const view = await gh(cwd, env, ['run', 'view', String(run.databaseId), '--json', 'jobs'])
    const jobs = view ? ((JSON.parse(view) as { jobs?: { status?: string }[] }).jobs ?? []) : []
    Object.assign(
      result,
      jobProgress(
        jobs.map((j) => j.status),
        actionsJobDone
      )
    )
  }
  return result
}

async function fetchCircle(repo: RepoRef, branch: string): Promise<CiResult> {
  const env = await loginShellEnv()
  const token = env['CIRCLECI_TOKEN'] ?? env['CIRCLE_TOKEN']
  // no token is a quiet skip, not an error — CircleCI v2 has no anonymous read
  if (!token) return { state: 'unknown' }
  const headers = { 'Circle-Token': token, Accept: 'application/json' }
  const slug = `bitbucket/${repo.owner}/${repo.repo}`
  const pipeRes = await fetch(
    `https://circleci.com/api/v2/project/${slug}/pipeline?branch=${encodeURIComponent(branch)}`,
    { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  )
  if (!pipeRes.ok) throw new Error(`circleci ${pipeRes.status}`)
  const pipelines = (await pipeRes.json()) as { items?: { id?: string; number?: number }[] }
  const id = pipelines.items?.[0]?.id
  if (!id) return { state: 'unknown' }
  const number = pipelines.items?.[0]?.number
  const wfRes = await fetch(`https://circleci.com/api/v2/pipeline/${id}/workflow`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!wfRes.ok) throw new Error(`circleci ${wfRes.status}`)
  const workflows =
    ((await wfRes.json()) as { items?: { id?: string; status?: string }[] }).items ?? []
  const state = circleCiCiState(workflows)
  const result: CiResult = {
    state,
    url: number != null ? `https://app.circleci.com/pipelines/${slug}/${number}` : undefined,
    detail: number != null ? `#${number}` : undefined
  }
  const live = workflows.find((w) => w.status === 'running')
  if (state === 'running' && live?.id) {
    const jobRes = await fetch(`https://circleci.com/api/v2/workflow/${live.id}/job`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (jobRes.ok) {
      const jobs = ((await jobRes.json()) as { items?: { status?: string }[] }).items ?? []
      Object.assign(
        result,
        jobProgress(
          jobs.map((j) => j.status),
          circleJobDone
        )
      )
    }
  }
  return result
}
