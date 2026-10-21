import type { BranchPr, PrInfo, PrReview, ReviewItem } from '../shared/types'

// Pure mapping from the gh CLI / Bitbucket API shapes to PrInfo — kept free of
// electron imports so it's unit-testable (pr-list.ts owns the I/O).

/** Dropdown cap: only the most recent open PRs are shown. */
export const MAX_PRS = 10

interface GhPr {
  number?: number
  title?: string
  url?: string
  author?: { login?: string; is_bot?: boolean }
}

/**
 * `gh pr list --json number,title,url,author` output (newest first). `viewer` is
 * the signed-in login; without it no PR is claimed as the user's own — better
 * unmarked than wrongly marked.
 */
export function mapGithubPrs(json: string, canMerge: boolean, viewer?: string | null): PrInfo[] {
  const rows = JSON.parse(json) as GhPr[]
  return rows
    .filter((r) => r.number != null && !!r.title && !!r.url)
    .slice(0, MAX_PRS)
    .map((r) => ({
      number: r.number!,
      title: r.title!,
      url: r.url!,
      canMerge,
      mine: !!viewer && r.author?.login === viewer
    }))
}

interface BbPr {
  id?: number
  title?: string
  links?: { html?: { href?: string } }
  author?: { account_id?: string }
}

/** Bitbucket 2.0 pullrequests listing (sorted -created_on by the query).
 *  People are compared by Atlassian account id — display names are not unique. */
export function mapBitbucketPrs(body: unknown, viewerId?: string | null): PrInfo[] {
  const rows = (body as { values?: BbPr[] }).values ?? []
  return rows
    .filter((r) => r.id != null && !!r.title && !!r.links?.html?.href)
    .slice(0, MAX_PRS)
    .map((r) => ({
      number: r.id!,
      title: r.title!,
      url: r.links!.html!.href!,
      canMerge: false,
      mine: !!viewerId && r.author?.account_id === viewerId
    }))
}

interface BbCommit {
  author?: { raw?: string; user?: { account_id?: string } }
}

/** Our account id from a commits listing: the first commit authored with
 *  `email` that Bitbucket linked to an account. For API tokens without the
 *  `read:user` scope, which can't ask `/2.0/user`. */
export function accountIdFromCommits(body: unknown, email: string): string | null {
  const needle = `<${email.trim().toLowerCase()}>`
  const rows = (body as { values?: BbCommit[] }).values ?? []
  const hit = rows.find(
    (c) => c.author?.user?.account_id && c.author.raw?.toLowerCase().includes(needle)
  )
  return hit?.author?.user?.account_id ?? null
}

interface GhBranchPr {
  url?: string
  number?: number
  title?: string
  isDraft?: boolean
  reviewDecision?: string | null
  latestReviews?: { state?: string }[]
  comments?: unknown[]
}

/** `gh pr list --head <branch> --json url,number,title,isDraft,reviewDecision,latestReviews,comments`.
 *  reviewDecision is empty on repos without required reviews — then the
 *  latest review per reviewer decides. */
export function githubBranchPr(json: string): BranchPr | null {
  const row = (JSON.parse(json) as GhBranchPr[])[0]
  if (!row?.url || row.number == null) return null
  const states = (row.latestReviews ?? []).map((r) => r.state)
  const approvals = states.filter((s) => s === 'APPROVED').length
  let review: PrReview = 'pending'
  if (row.reviewDecision === 'APPROVED') review = 'approved'
  else if (row.reviewDecision === 'CHANGES_REQUESTED') review = 'changes'
  else if (!row.reviewDecision) {
    if (states.includes('CHANGES_REQUESTED')) review = 'changes'
    else if (approvals > 0) review = 'approved'
  }
  return {
    url: row.url,
    number: row.number,
    title: row.title ?? '',
    review,
    approvals,
    draft: !!row.isDraft,
    comments: row.comments?.length ?? null
  }
}

interface BbBranchPr {
  id?: number
  state?: string
  title?: string
  draft?: boolean
  comment_count?: number
  links?: { html?: { href?: string } }
  participants?: { approved?: boolean; state?: string | null }[]
}

/** Bitbucket pullrequests listing filtered on the source branch, with
 *  participants. Any "changes requested" outweighs approvals. */
export function bitbucketBranchPr(body: unknown): BranchPr | null {
  // Bitbucket drops a `state=` parameter once `q` is given — never trust the
  // query alone to have kept merged PRs out
  const row = ((body as { values?: BbBranchPr[] }).values ?? []).find(
    (r) => !r.state || r.state === 'OPEN'
  )
  const url = row?.links?.html?.href
  if (!row || !url || row.id == null) return null
  const people = row.participants ?? []
  const approvals = people.filter((p) => p.approved || p.state === 'approved').length
  const changes = people.some((p) => p.state === 'changes_requested')
  return {
    url,
    number: row.id,
    title: row.title ?? '',
    review: changes ? 'changes' : approvals > 0 ? 'approved' : 'pending',
    approvals,
    draft: !!row.draft,
    comments: row.comment_count ?? null
  }
}

interface BbReviewPr {
  id?: number
  title?: string
  links?: { html?: { href?: string } }
  author?: { display_name?: string }
  participants?: { user?: { account_id?: string }; approved?: boolean; state?: string | null }[]
}

/** Open PRs listing a reviewer, with what that reviewer already said. */
export function mapBitbucketReviews(body: unknown, repo: string, viewerId: string): ReviewItem[] {
  const rows = (body as { values?: BbReviewPr[] }).values ?? []
  return rows
    .filter((r) => r.id != null && r.title && r.links?.html?.href)
    .map((r) => {
      const me = r.participants?.find((p) => p.user?.account_id === viewerId)
      return {
        repo,
        number: r.id!,
        title: r.title!,
        url: r.links!.html!.href!,
        author: r.author?.display_name ?? '',
        myVerdict: me?.state === 'changes_requested' ? 'changes' : me?.approved ? 'approved' : null
      }
    })
}

interface GhSearchPr {
  number?: number
  title?: string
  url?: string
  repository?: { nameWithOwner?: string }
  author?: { login?: string }
}

/** `gh search prs --review-requested=@me --json number,title,url,repository,author`.
 *  GitHub drops the request once you review, so no verdict is ever known here. */
export function mapGithubReviews(json: string): ReviewItem[] {
  return (JSON.parse(json) as GhSearchPr[])
    .filter((r) => r.number != null && r.title && r.url)
    .map((r) => ({
      repo: r.repository?.nameWithOwner ?? '',
      number: r.number!,
      title: r.title!,
      url: r.url!,
      author: r.author?.login ?? '',
      myVerdict: null
    }))
}

/** The branch's newest PR in any state (`q` on the branch, sorted -updated_on):
 *  open → its review state, merged → merged, declined or none → nothing. */
export function bitbucketBranchState(body: unknown): {
  pr: BranchPr | null
  merged: { number: number; url: string } | null
} {
  const row = ((body as { values?: BbBranchPr[] }).values ?? [])[0]
  const url = row?.links?.html?.href
  if (!row || !url || row.id == null) return { pr: null, merged: null }
  if (row.state === 'MERGED') return { pr: null, merged: { number: row.id, url } }
  if (row.state === 'OPEN') return { pr: bitbucketBranchPr({ values: [row] }), merged: null }
  return { pr: null, merged: null }
}
