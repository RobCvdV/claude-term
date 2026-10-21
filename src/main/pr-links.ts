import { execFile } from 'child_process'
import type { BranchPr } from '../shared/types'
import type { RepoRef } from '../shared/repo-links'
import { isTrunkBranch } from '../shared/repo-links'
import { bitbucketGet } from './bitbucket-api'
import { forBranch, mergedBitbucketPrs, openBitbucketPrs } from './bitbucket-prs'
import { bitbucketBranchPr, bitbucketBranchState, githubBranchPr } from './pr-data'
import { loginShellEnv } from './shell-env'

/** How long a resolved answer (PR or "no PR") stays good. */
const TTL_MS = 120_000
/** Hold after a failed lookup (the last answer stays up meanwhile) — short,
 *  since most failures are a dropped connection, not a missing token. */
const TTL_ERROR_MS = 90_000

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
    if (repo.host === 'github') {
      pr = await githubPr(cwd, branch)
      if (!pr) merged = await githubMerged(cwd, branch)
    } else {
      ;({ pr, merged } = await bitbucketBranch(repo, branch))
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

/**
 * From the repo's shared open and merged listings. A busy repo's listings are
 * one page each, so a branch missing from both asks Bitbucket directly for its
 * newest PR in any state — `state` is filtered by hand, as Bitbucket ignores a
 * `state=` parameter next to `q`.
 */
async function bitbucketBranch(
  repo: RepoRef,
  branch: string
): Promise<{ pr: BranchPr | null; merged: MergedPr | null }> {
  const open = await openBitbucketPrs(repo)
  const pr = bitbucketBranchPr(forBranch(open, branch))
  if (pr) return { pr, merged: null }
  const mergedListing = await mergedBitbucketPrs(repo)
  const rows = forBranch(mergedListing, branch).values as {
    id?: number
    links?: { html?: { href?: string } }
  }[]
  const url = rows[0]?.links?.html?.href
  if (rows[0]?.id != null && url) return { pr: null, merged: { number: rows[0].id, url } }
  if (!open.truncated && !mergedListing.truncated) return { pr: null, merged: null }
  const params = new URLSearchParams({
    q: `source.branch.name="${branch}"`,
    sort: '-updated_on',
    pagelen: '1',
    fields:
      'values.id,values.state,values.title,values.draft,values.comment_count,' +
      'values.links.html.href,values.participants.approved,values.participants.state'
  })
  return bitbucketBranchState(
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
