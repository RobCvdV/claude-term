import type { BoardPr, ReviewItem, TicketStatus, WorkContext, WorkItem } from '../shared/types'
import { branchTicket, ticketUrl } from '../shared/jira-labels'
import { bitbucketBranchPr, githubPr } from './pr-data'
import { mapTicketStatus } from './jira-todo-data'
import { githubRollupCi } from './ci-data'

// Pure mapping and joining for the Work board — work-board.ts owns the I/O.

export type BoardTicket = TicketStatus & { type: string; labels: string[]; updated: number }

export interface SourcePr {
  pr: BoardPr
  host: 'bitbucket' | 'github'
  /** Bitbucket workspace / GitHub owner */
  owner: string
  updated: number
  /** head commit, to look its build up by (Bitbucket) */
  hash?: string
}

export interface SourceIssue {
  repo: string
  number: number
  title: string
  url: string
  updated: number
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0)

interface RawJiraIssue {
  key?: string
  fields?: { issuetype?: { name?: string }; labels?: string[]; updated?: string }
}

/** `/search/jql` with fields summary,status,assignee,issuetype,labels,updated. */
export function mapMyJiraIssues(body: unknown): BoardTicket[] {
  const out: BoardTicket[] = []
  for (const issue of (body as { issues?: RawJiraIssue[] }).issues ?? []) {
    const t = issue.key ? mapTicketStatus(issue, issue.key) : null
    if (!t) continue
    out.push({
      ...t,
      type: issue.fields?.issuetype?.name ?? '',
      labels: issue.fields?.labels ?? [],
      updated: time(issue.fields?.updated)
    })
  }
  return out
}

/** A status the context leaves off the board ("Beta" covers "Beta (mobile)"). */
export function excludedStatus(status: string, exclude: readonly string[]): boolean {
  const s = status.toLowerCase()
  return exclude.some((x) => s.startsWith(x.toLowerCase()))
}

interface RawBbPr {
  updated_on?: string
  source?: { branch?: { name?: string }; commit?: { hash?: string } }
  destination?: { repository?: { full_name?: string } }
}

/** `/workspaces/{ws}/pullrequests/{me}?state=OPEN`, with branch, commit and participants. */
export function mapBitbucketMyPrs(body: unknown, workspace: string): SourcePr[] {
  const out: SourcePr[] = []
  for (const row of (body as { values?: RawBbPr[] }).values ?? []) {
    const pr = bitbucketBranchPr({ values: [row] })
    if (!pr) continue
    out.push({
      pr: {
        ...pr,
        repo: row.destination?.repository?.full_name ?? '',
        branch: row.source?.branch?.name ?? '',
        ci: null
      },
      host: 'bitbucket',
      owner: workspace,
      updated: time(row.updated_on),
      hash: row.source?.commit?.hash
    })
  }
  return out
}

interface GqlPr {
  number?: number
  title?: string
  url?: string
  isDraft?: boolean
  reviewDecision?: string | null
  headRefName?: string
  updatedAt?: string
  repository?: { nameWithOwner?: string }
  comments?: { totalCount?: number }
  latestReviews?: { nodes?: { state?: string }[] }
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] }
}

interface GqlIssue {
  number?: number
  title?: string
  url?: string
  updatedAt?: string
  repository?: { nameWithOwner?: string }
}

/** The GITHUB_WORK_QUERY answer: my open PRs and the open issues assigned to me. */
export function mapGithubWork(body: unknown): { prs: SourcePr[]; issues: SourceIssue[] } {
  const data = (body as { data?: { prs?: { nodes?: GqlPr[] }; issues?: { nodes?: GqlIssue[] } } })
    .data
  const prs: SourcePr[] = []
  for (const n of data?.prs?.nodes ?? []) {
    const pr = githubPr({
      ...n,
      reviewStates: (n.latestReviews?.nodes ?? []).map((r) => r.state),
      comments: n.comments?.totalCount ?? null
    })
    if (!pr) continue
    const repo = n.repository?.nameWithOwner ?? ''
    const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
    prs.push({
      pr: { ...pr, repo, branch: n.headRefName ?? '', ci: githubRollupCi(rollup, pr.url) },
      host: 'github',
      owner: repo.split('/')[0],
      updated: time(n.updatedAt)
    })
  }
  const issues: SourceIssue[] = (data?.issues?.nodes ?? [])
    .filter((n) => n.number != null && n.title && n.url)
    .map((n) => ({
      repo: n.repository?.nameWithOwner ?? '',
      number: n.number!,
      title: n.title!,
      url: n.url!,
      updated: time(n.updatedAt)
    }))
  return { prs, issues }
}

export const GITHUB_WORK_QUERY = `query {
  prs: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft reviewDecision headRefName updatedAt
      repository { nameWithOwner }
      comments { totalCount }
      latestReviews(first: 20) { nodes { state } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
  issues: search(query: "is:issue is:open assignee:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } }
  }
}`

/** Which context a PR host/owner belongs to. */
function contextFor(
  contexts: readonly WorkContext[],
  host: 'bitbucket' | 'github',
  owner: string
): WorkContext | undefined {
  return host === 'github'
    ? contexts.find((c) => c.github)
    : contexts.find((c) => c.bitbucketWorkspaces.includes(owner))
}

/** The host and owner a review's PR url points at. */
function reviewSource(url: string): { host: 'bitbucket' | 'github'; owner: string } | null {
  const m = /^https:\/\/(bitbucket\.org|github\.com)\/([^/]+)\//.exec(url)
  if (!m) return null
  return { host: m[1] === 'github.com' ? 'github' : 'bitbucket', owner: m[2] }
}

/**
 * One card per ticket (with the PRs whose branch names it), then every PR,
 * issue and review that no ticket claimed. Newest change first.
 */
export function joinWork(input: {
  contexts: readonly WorkContext[]
  tickets: readonly BoardTicket[]
  prs: readonly SourcePr[]
  issues: readonly SourceIssue[]
  reviews: readonly ReviewItem[]
}): WorkItem[] {
  const { contexts } = input
  const items: WorkItem[] = []
  const byTicket = new Map<string, WorkItem>()
  /** my tickets already past the board's end (Deploy, Beta, Done) */
  const passed = new Map<string, NonNullable<WorkItem['ticket']>>()

  const jiraCtx = contexts.find((c) => c.jira)
  for (const t of jiraCtx ? input.tickets : []) {
    const { updated, ...ticket } = t
    if (excludedStatus(t.status, jiraCtx!.jira!.excludeStatuses)) {
      passed.set(t.key, ticket)
      continue
    }
    const item: WorkItem = {
      id: t.key,
      context: jiraCtx!.id,
      kind: 'ticket',
      title: t.summary,
      url: ticketUrl(t.key),
      ticket,
      prs: [],
      review: null,
      updated,
      starts: [],
      handedOff: null,
      warning: null
    }
    byTicket.set(t.key, item)
    items.push(item)
  }

  for (const src of input.prs) {
    const key = branchTicket(src.pr.branch) ?? ''
    const owner = byTicket.get(key)
    if (owner) {
      owner.prs.push(src.pr)
      owner.updated = Math.max(owner.updated, src.updated)
      continue
    }
    const ticket = passed.get(key)
    if (ticket) {
      items.push({
        id: src.pr.url,
        context: jiraCtx!.id,
        kind: 'pr',
        title: src.pr.title,
        url: src.pr.url,
        ticket,
        prs: [src.pr],
        review: null,
        updated: src.updated,
        starts: [],
        handedOff: null,
        warning: `${key} is already in ${ticket.status}, but this PR isn't merged — changes may be missing`
      })
      continue
    }
    const ctx = contextFor(contexts, src.host, src.owner)
    if (!ctx) continue
    items.push({
      id: src.pr.url,
      context: ctx.id,
      kind: 'pr',
      title: src.pr.title,
      url: src.pr.url,
      ticket: null,
      prs: [src.pr],
      review: null,
      updated: src.updated,
      starts: [],
      handedOff: null,
      warning: null
    })
  }

  const githubCtx = contexts.find((c) => c.github)
  for (const issue of githubCtx ? input.issues : []) {
    items.push({
      id: issue.url,
      context: githubCtx!.id,
      kind: 'issue',
      title: issue.title,
      url: issue.url,
      ticket: null,
      prs: [],
      review: null,
      updated: issue.updated,
      starts: [],
      handedOff: null,
      warning: null
    })
  }

  for (const review of input.reviews) {
    const src = reviewSource(review.url)
    const ctx = src && contextFor(contexts, src.host, src.owner)
    if (!ctx) continue
    items.push({
      id: `review:${review.url}`,
      context: ctx.id,
      kind: 'review',
      title: review.title,
      url: review.url,
      ticket: null,
      prs: [],
      review,
      updated: 0,
      starts: [],
      handedOff: null,
      warning: null
    })
  }

  return items.sort((a, b) => b.updated - a.updated)
}
