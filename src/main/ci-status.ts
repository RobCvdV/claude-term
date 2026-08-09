import { execFile } from 'child_process'
import { basename } from 'path'
import type { CiInfo, CiProvider, CiState, TabId, TabStatus } from '../shared/types'
import {
  actionsUrl,
  circleCiUrl,
  jenkinsJobUrl,
  parseRemote,
  type RepoRef
} from '../shared/repo-links'
import { actionsCiState, circleCiCiState, jenkinsCiState } from './ci-data'
import { loginShellEnv } from './shell-env'

/**
 * Background CI poller: one fetch per distinct provider+repo+branch per sweep
 * (many tabs on the same branch share the answer), every ~60s while the app
 * window is visible. Results land in TabStatus.ci via the status server.
 */

const POLL_MS = 60_000
/** hold failures longer, so a missing token / offline CI isn't hammered */
const ERROR_BACKOFF_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 10_000

interface Target {
  key: string
  provider: CiProvider
  url: string
  fetch: () => Promise<CiState>
}

interface Cached {
  state: CiState
  fetchedAt: number
  failedFetch: boolean
}

export class CiPoller {
  private timer: NodeJS.Timeout | null = null
  private cache = new Map<string, Cached>()
  private sweeping = false

  constructor(
    private readonly getSnapshots: () => TabStatus[],
    private readonly setCi: (tabId: TabId, ci: CiInfo | null) => void,
    private readonly isActive: () => boolean
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), POLL_MS)
    setTimeout(() => void this.sweep(), 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || !this.isActive()) return
    this.sweeping = true
    try {
      // group tabs by distinct CI target so each is fetched once
      const jobs = new Map<string, { target: Target; tabs: TabId[] }>()
      for (const snap of this.getSnapshots()) {
        const target = targetFor(snap)
        if (!target) {
          this.setCi(snap.tabId, null)
          continue
        }
        const job = jobs.get(target.key) ?? { target, tabs: [] }
        job.tabs.push(snap.tabId)
        jobs.set(target.key, job)
      }
      // sequential fetches: natural stagger, and there are only a few keys
      for (const { target, tabs } of jobs.values()) {
        const cached = this.cache.get(target.key)
        const ttl = cached?.failedFetch ? ERROR_BACKOFF_MS : POLL_MS - 5_000
        if (!cached || Date.now() - cached.fetchedAt > ttl) {
          let state: CiState = 'unknown'
          let failedFetch = false
          try {
            state = await target.fetch()
          } catch {
            failedFetch = true
          }
          this.cache.set(target.key, { state, fetchedAt: Date.now(), failedFetch })
        }
        const state = this.cache.get(target.key)!.state
        for (const tabId of tabs) {
          this.setCi(
            tabId,
            state === 'unknown' ? null : { provider: target.provider, state, url: target.url }
          )
        }
      }
    } finally {
      this.sweeping = false
    }
  }
}

function targetFor(snap: TabStatus): Target | null {
  const git = snap.git
  if (!git?.branch) return null
  const branch = git.branch
  const jenkins = jenkinsJobUrl(basename(snap.cwd), branch)
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
      fetch: () => fetchActions(snap.cwd, branch)
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

async function fetchJenkins(jobUrl: string): Promise<CiState> {
  const env = await loginShellEnv()
  const headers: Record<string, string> = { Accept: 'application/json' }
  const user = env['JENKINS_USER']
  const token = env['JENKINS_API_TOKEN'] ?? env['JENKINS_TOKEN']
  if (user && token) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64')
  }
  const res = await fetch(`${jobUrl}lastBuild/api/json?tree=building,result`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  // no such job (e.g. a branch Jenkins never built) — nothing to show, no error
  if (res.status === 404) return 'unknown'
  if (!res.ok) throw new Error(`jenkins ${res.status}`)
  return jenkinsCiState((await res.json()) as { building?: boolean; result?: string | null })
}

/** Rides the `gh` CLI's existing auth, like the PR lookups. */
async function fetchActions(cwd: string, branch: string): Promise<CiState> {
  const env = await loginShellEnv()
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      'gh',
      ['run', 'list', '--branch', branch, '--limit', '1', '--json', 'status,conclusion'],
      { cwd, env, timeout: FETCH_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
  if (out === null) throw new Error('gh run list failed')
  return actionsCiState(JSON.parse(out) as { status?: string; conclusion?: string | null }[])
}

async function fetchCircle(repo: RepoRef, branch: string): Promise<CiState> {
  const env = await loginShellEnv()
  const token = env['CIRCLECI_TOKEN'] ?? env['CIRCLE_TOKEN']
  // no token is a quiet skip, not an error — CircleCI v2 has no anonymous read
  if (!token) return 'unknown'
  const headers = { 'Circle-Token': token, Accept: 'application/json' }
  const slug = `bitbucket/${repo.owner}/${repo.repo}`
  const pipeRes = await fetch(
    `https://circleci.com/api/v2/project/${slug}/pipeline?branch=${encodeURIComponent(branch)}`,
    { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  )
  if (!pipeRes.ok) throw new Error(`circleci ${pipeRes.status}`)
  const pipelines = (await pipeRes.json()) as { items?: { id?: string }[] }
  const id = pipelines.items?.[0]?.id
  if (!id) return 'unknown'
  const wfRes = await fetch(`https://circleci.com/api/v2/pipeline/${id}/workflow`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!wfRes.ok) throw new Error(`circleci ${wfRes.status}`)
  const workflows = (await wfRes.json()) as { items?: { status?: string }[] }
  return circleCiCiState(workflows.items ?? [])
}
