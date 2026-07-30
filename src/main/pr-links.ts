import { execFile } from 'child_process'
import type { RepoRef } from '../shared/repo-links'
import { isTrunkBranch } from '../shared/repo-links'
import { loginShellEnv } from './shell-env'

/** How long a resolved answer (PR or "no PR") stays good. */
const TTL_MS = 120_000
/** Longer hold after a failed lookup, so a missing token or offline network
 *  doesn't turn into a request every git poll. */
const TTL_ERROR_MS = 600_000

interface Entry {
  url: string | null
  expiresAt: number
  inflight: boolean
}

const cache = new Map<string, Entry>()

/**
 * Web URL of the open pull request for `branch`, or null when there is none
 * (yet). Answers from cache only — a stale entry triggers a background refresh
 * and the next git poll picks up the result, so status updates never wait on
 * the network.
 */
export function pullRequestUrl(cwd: string, repo: RepoRef, branch: string): string | null {
  if (isTrunkBranch(branch)) return null
  const key = `${repo.host}/${repo.owner}/${repo.repo}#${branch}`
  const entry = cache.get(key)
  if (!entry || (entry.expiresAt < Date.now() && !entry.inflight)) {
    void refresh(key, cwd, repo, branch)
  }
  return entry?.url ?? null
}

async function refresh(key: string, cwd: string, repo: RepoRef, branch: string): Promise<void> {
  const prev = cache.get(key)
  cache.set(key, { url: prev?.url ?? null, expiresAt: prev?.expiresAt ?? 0, inflight: true })
  let url: string | null = null
  let ok = true
  try {
    url =
      repo.host === 'github' ? await githubPrUrl(cwd, branch) : await bitbucketPrUrl(repo, branch)
  } catch {
    ok = false
  }
  cache.set(key, {
    url: ok ? url : (prev?.url ?? null),
    expiresAt: Date.now() + (ok ? TTL_MS : TTL_ERROR_MS),
    inflight: false
  })
}

/** Uses the `gh` CLI so we ride on its existing auth (private repos included). */
async function githubPrUrl(cwd: string, branch: string): Promise<string | null> {
  const env = await loginShellEnv()
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'url'],
      { cwd, env, timeout: 10_000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
  if (out === null) throw new Error('gh pr list failed')
  const rows = JSON.parse(out) as { url?: string }[]
  return rows[0]?.url ?? null
}

async function bitbucketPrUrl(repo: RepoRef, branch: string): Promise<string | null> {
  const env = await loginShellEnv()
  const email = env.BITBUCKET_EMAIL
  const token = env.BITBUCKET_API_TOKEN
  if (!email || !token) throw new Error('no bitbucket credentials')
  const params = new URLSearchParams({
    q: `source.branch.name="${branch}"`,
    state: 'OPEN',
    pagelen: '1',
    fields: 'values.links.html.href'
  })
  const res = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${repo.owner}/${repo.repo}/pullrequests?${params}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    }
  )
  if (!res.ok) throw new Error(`bitbucket ${res.status}`)
  const body = (await res.json()) as { values?: { links?: { html?: { href?: string } } }[] }
  return body.values?.[0]?.links?.html?.href ?? null
}
