import { execFile } from 'child_process'
import type { BranchPr } from '../shared/types'
import type { RepoRef } from '../shared/repo-links'
import { isTrunkBranch } from '../shared/repo-links'
import { bitbucketGet } from './bitbucket-api'
import { bitbucketBranchPr, githubBranchPr } from './pr-data'
import { loginShellEnv } from './shell-env'
import { branchTicket } from './ticket-status'

/** How long a resolved answer (PR or "no PR") stays good. */
const TTL_MS = 120_000
/** Longer hold after a failed lookup, so a missing token or offline network
 *  doesn't turn into a request every git poll. */
const TTL_ERROR_MS = 600_000

export interface MergedPr {
  number: number
  url: string
}

interface Entry {
  pr: BranchPr | null
  merged: MergedPr | null
  expiresAt: number
  inflight: boolean
}

const cache = new Map<string, Entry>()

/**
 * The open pull request for `branch` with its review state, or null when there
 * is none (yet). Answers from cache only — a stale entry triggers a background
 * refresh and the next git poll picks up the result, so status updates never
 * wait on the network.
 */
export function branchPullRequest(
  cwd: string,
  repo: RepoRef,
  branch: string
): { pr: BranchPr | null; merged: MergedPr | null } {
  if (isTrunkBranch(branch)) return { pr: null, merged: null }
  const key = `${repo.host}/${repo.owner}/${repo.repo}#${branch}`
  const entry = cache.get(key)
  if (!entry || (entry.expiresAt < Date.now() && !entry.inflight)) {
    void refresh(key, cwd, repo, branch)
  }
  return { pr: entry?.pr ?? null, merged: entry?.merged ?? null }
}

async function refresh(key: string, cwd: string, repo: RepoRef, branch: string): Promise<void> {
  const prev = cache.get(key)
  cache.set(key, {
    pr: prev?.pr ?? null,
    merged: prev?.merged ?? null,
    expiresAt: prev?.expiresAt ?? 0,
    inflight: true
  })
  let pr: BranchPr | null = null
  let merged: MergedPr | null = null
  let ok = true
  try {
    pr = repo.host === 'github' ? await githubPr(cwd, branch) : await bitbucketPr(repo, branch)
    // only ticket branches have a board state a merge should have moved on
    if (!pr && branchTicket(branch)) {
      merged =
        repo.host === 'github'
          ? await githubMerged(cwd, branch)
          : await bitbucketMerged(repo, branch)
    }
  } catch {
    ok = false
  }
  cache.set(key, {
    pr: ok ? pr : (prev?.pr ?? null),
    merged: ok ? merged : (prev?.merged ?? null),
    expiresAt: Date.now() + (ok ? TTL_MS : TTL_ERROR_MS),
    inflight: false
  })
}

/** Uses the `gh` CLI so we ride on its existing auth (private repos included). */
async function githubPr(cwd: string, branch: string): Promise<BranchPr | null> {
  const env = await loginShellEnv()
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--limit',
        '1',
        '--json',
        'url,number,title,isDraft,reviewDecision,latestReviews,comments'
      ],
      { cwd, env, timeout: 10_000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
  if (out === null) throw new Error('gh pr list failed')
  return githubBranchPr(out)
}

async function bitbucketPr(repo: RepoRef, branch: string): Promise<BranchPr | null> {
  const params = new URLSearchParams({
    q: `source.branch.name="${branch}"`,
    state: 'OPEN',
    pagelen: '1',
    fields:
      'values.id,values.title,values.draft,values.comment_count,values.links.html.href,' +
      'values.participants.approved,values.participants.state'
  })
  return bitbucketBranchPr(
    await bitbucketGet(`/repositories/${repo.owner}/${repo.repo}/pullrequests`, params)
  )
}

async function githubMerged(cwd: string, branch: string): Promise<MergedPr | null> {
  const env = await loginShellEnv()
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1', '--json', 'number,url'],
      { cwd, env, timeout: 10_000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
  if (out === null) throw new Error('gh pr list failed')
  const row = (JSON.parse(out) as { number?: number; url?: string }[])[0]
  return row?.number != null && row.url ? { number: row.number, url: row.url } : null
}

async function bitbucketMerged(repo: RepoRef, branch: string): Promise<MergedPr | null> {
  const params = new URLSearchParams({
    q: `source.branch.name="${branch}"`,
    state: 'MERGED',
    sort: '-updated_on',
    pagelen: '1',
    fields: 'values.id,values.links.html.href'
  })
  const body = (await bitbucketGet(
    `/repositories/${repo.owner}/${repo.repo}/pullrequests`,
    params
  )) as { values?: { id?: number; links?: { html?: { href?: string } } }[] }
  const row = body.values?.[0]
  const url = row?.links?.html?.href
  return row?.id != null && url ? { number: row.id, url } : null
}
