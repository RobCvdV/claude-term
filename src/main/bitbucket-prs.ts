import type { RepoRef } from '../shared/repo-links'
import { bitbucketGet } from './bitbucket-api'

/**
 * One open-PR listing per Bitbucket repo, shared by the PR dropdown, the
 * branch PR dots and the review queue — Bitbucket allows ~1000 calls an hour,
 * and the same token is often busy in other tools too. Merged PRs are a
 * second, slower listing.
 */

const OPEN_TTL_MS = 110_000
const MERGED_TTL_MS = 10 * 60_000
const ERROR_TTL_MS = 90_000
/** Bitbucket said slow down — hold off properly */
const RATE_LIMITED_TTL_MS = 5 * 60_000
const PAGE = 50

export interface BbListing {
  values: unknown[]
  /** more open PRs than one page — a branch not in it may still have one */
  truncated: boolean
}

interface Entry {
  listing: BbListing | null
  expiresAt: number
  inflight: Promise<BbListing> | null
}

const open = new Map<string, Entry>()
const merged = new Map<string, Entry>()

const OPEN_FIELDS = [
  'next',
  'values.id',
  'values.title',
  'values.draft',
  'values.comment_count',
  'values.links.html.href',
  'values.author.account_id',
  'values.author.display_name',
  'values.source.branch.name',
  'values.reviewers.account_id',
  'values.participants.user.account_id',
  'values.participants.approved',
  'values.participants.state'
].join(',')

export function openBitbucketPrs(repo: RepoRef): Promise<BbListing> {
  return cached(open, repo, OPEN_TTL_MS, () =>
    list(
      repo,
      new URLSearchParams({
        state: 'OPEN',
        sort: '-created_on',
        pagelen: String(PAGE),
        fields: OPEN_FIELDS
      })
    )
  )
}

/** Recently merged PRs, newest first. */
export function mergedBitbucketPrs(repo: RepoRef): Promise<BbListing> {
  return cached(merged, repo, MERGED_TTL_MS, () =>
    list(
      repo,
      new URLSearchParams({
        state: 'MERGED',
        sort: '-updated_on',
        pagelen: String(PAGE),
        fields: 'next,values.id,values.links.html.href,values.source.branch.name'
      })
    )
  )
}

async function list(repo: RepoRef, params: URLSearchParams): Promise<BbListing> {
  const body = (await bitbucketGet(
    `/repositories/${repo.owner}/${repo.repo}/pullrequests`,
    params
  )) as { values?: unknown[]; next?: string }
  return { values: body.values ?? [], truncated: !!body.next }
}

/** Fresh answer, else one shared fetch; a failure serves the last listing (or throws without one). */
async function cached(
  store: Map<string, Entry>,
  repo: RepoRef,
  ttl: number,
  fetchIt: () => Promise<BbListing>
): Promise<BbListing> {
  const key = `${repo.owner}/${repo.repo}`
  const entry = store.get(key)
  if (entry?.listing && entry.expiresAt > Date.now()) return entry.listing
  if (entry?.inflight) return entry.inflight
  if (entry && !entry.listing && entry.expiresAt > Date.now()) throw new Error('bitbucket backoff')
  const inflight = fetchIt()
    .then((listing) => {
      store.set(key, { listing, expiresAt: Date.now() + ttl, inflight: null })
      return listing
    })
    .catch((err: unknown) => {
      const stale = store.get(key)?.listing ?? null
      const hold = String(err).includes('bitbucket 429') ? RATE_LIMITED_TTL_MS : ERROR_TTL_MS
      store.set(key, { listing: stale, expiresAt: Date.now() + hold, inflight: null })
      if (stale) return stale
      throw err
    })
  store.set(key, { listing: entry?.listing ?? null, expiresAt: entry?.expiresAt ?? 0, inflight })
  return inflight
}

/** Drop a repo's open listing, e.g. after a merge from the app. */
export function forgetBitbucketPrs(repo: RepoRef): void {
  open.delete(`${repo.owner}/${repo.repo}`)
}

/** The listing's rows whose source branch is `branch`, as a listing body. */
export function forBranch(listing: BbListing, branch: string): { values: unknown[] } {
  return {
    values: listing.values.filter(
      (v) => (v as { source?: { branch?: { name?: string } } }).source?.branch?.name === branch
    )
  }
}

/** My open PRs across a whole workspace — one call instead of one per repo. */
export function myWorkspacePrs(workspace: string, accountId: string): Promise<unknown> {
  return bitbucketGet(
    `/workspaces/${workspace}/pullrequests/${encodeURIComponent(accountId)}`,
    new URLSearchParams({
      state: 'OPEN',
      pagelen: String(PAGE),
      fields: [
        'values.id',
        'values.title',
        'values.draft',
        'values.comment_count',
        'values.updated_on',
        'values.links.html.href',
        'values.participants.approved',
        'values.participants.state',
        'values.source.branch.name',
        'values.source.commit.hash',
        'values.destination.repository.full_name'
      ].join(',')
    })
  )
}

/** Build statuses reported on a commit (Jenkins, CircleCI, Pipelines). */
export function commitStatuses(fullRepo: string, hash: string): Promise<unknown> {
  return bitbucketGet(
    `/repositories/${fullRepo}/commit/${hash}/statuses`,
    new URLSearchParams({
      pagelen: '20',
      sort: '-updated_on',
      fields: 'values.state,values.name,values.url'
    })
  )
}

/** A few recently active repos of a workspace, to find my account id in. */
export async function recentWorkspaceRepos(workspace: string): Promise<RepoRef[]> {
  const body = (await bitbucketGet(
    `/repositories/${workspace}`,
    new URLSearchParams({ sort: '-updated_on', pagelen: '5', fields: 'values.slug' })
  )) as { values?: { slug?: string }[] }
  return (body.values ?? [])
    .filter((v) => v.slug)
    .map((v) => ({ host: 'bitbucket', owner: workspace, repo: v.slug! }))
}
