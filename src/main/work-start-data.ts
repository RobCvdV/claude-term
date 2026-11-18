import type { BoardStart, BranchHistoryEntry, WorkContext, WorkItem } from '../shared/types'
import { branchTicket, jiraLabelsFor } from '../shared/jira-labels'
import type { RepoRef } from '../shared/repo-links'

/** A menu, not a directory listing. */
const MAX_STARTS = 12

export interface LocalRepo {
  root: string
  ref: RepoRef
}

/** host + `owner/repo` of a PR, issue or repo web url */
function urlRepo(url: string): RepoRef | null {
  const m = /^https:\/\/(bitbucket\.org|github\.com)\/([^/]+)\/([^/]+)/.exec(url)
  if (!m) return null
  return { host: m[1] === 'github.com' ? 'github' : 'bitbucket', owner: m[2], repo: m[3] }
}

const sameRepo = (a: RepoRef, b: RepoRef): boolean =>
  a.host === b.host &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase()

/**
 * The local clones a card can start a session in, best first: where its branch
 * was checked out before, then clones of its PR/issue repo, and for a ticket
 * without either, the clones its Jira labels point at (else the workspaces'
 * clones used before).
 */
export function startsFor(
  item: WorkItem,
  repos: readonly LocalRepo[],
  history: readonly BranchHistoryEntry[],
  contexts: readonly WorkContext[]
): BoardStart[] {
  const recency = new Map<string, number>()
  for (const e of history) recency.set(e.root, Math.max(recency.get(e.root) ?? 0, e.lastUsed))
  const out: BoardStart[] = []
  const rank = (s: BoardStart): number => (s.sure ? 2 : 0) + (s.branch ? 1 : 0)
  const add = (s: BoardStart): void => {
    const i = out.findIndex((o) => o.root === s.root)
    if (i < 0) out.push(s)
    else if (rank(s) > rank(out[i])) out[i] = s
  }
  const clonesOf = (url: string): LocalRepo[] => {
    const ref = urlRepo(url)
    return ref ? repos.filter((r) => sameRepo(r.ref, ref)) : []
  }

  const key = item.ticket?.key
  if (key) {
    for (const e of history) {
      if (branchTicket(e.branch) === key) add({ root: e.root, branch: e.branch, sure: true })
    }
  }
  for (const pr of item.prs) {
    const clones = clonesOf(pr.url)
    for (const r of clones) {
      const seen = history.some((e) => e.root === r.root && e.branch === pr.branch)
      add({ root: r.root, branch: pr.branch, sure: seen || clones.length === 1 })
    }
  }
  if (item.kind === 'issue' || item.kind === 'review') {
    const clones = clonesOf(item.url)
    for (const r of clones) add({ root: r.root, branch: null, sure: clones.length === 1 })
  }
  if (item.ticket && out.length === 0) {
    const workspaces = contexts.find((c) => c.id === item.context)?.bitbucketWorkspaces ?? []
    const fit = repos.filter((r) => r.ref.host === 'bitbucket' && workspaces.includes(r.ref.owner))
    const labels = item.ticket.labels
    const labelled = fit.filter((r) => jiraLabelsFor(r.ref.repo)?.some((l) => labels.includes(l)))
    const used = fit.filter((r) => recency.has(r.root))
    const pool = labelled.length ? labelled : used.length ? used : fit
    for (const r of pool) add({ root: r.root, branch: null, sure: false })
  }
  return out
    .sort((a, b) => rank(b) - rank(a) || (recency.get(b.root) ?? 0) - (recency.get(a.root) ?? 0))
    .slice(0, MAX_STARTS)
}

/** What changed on the card's PRs that needs a look. */
function prNotes(item: WorkItem): string[] {
  const notes: string[] = []
  for (const pr of item.prs) {
    if (pr.ci?.state === 'failed') {
      const where = pr.ci.url ? ` (${pr.ci.url})` : ''
      notes.push(`The ${pr.ci.name || 'build'} build of ${pr.url} failed${where}: find out why.`)
    }
    if (pr.review === 'changes') {
      notes.push(`Reviewers requested changes on ${pr.url}: go through their comments.`)
    }
  }
  return notes
}

/** What the new session is asked first. `ticketPrompt` is the ticket start prompt, if any. */
export function cardPrompt(item: WorkItem, ticketPrompt: string | null): string {
  const notes = prNotes(item)
  if (ticketPrompt) {
    return notes.length
      ? `${ticketPrompt}\n\nAlso:\n${notes.map((n) => `- ${n}`).join('\n')}`
      : ticketPrompt
  }
  if (item.kind === 'review') {
    return `Review ${item.url} — ${item.title}. Read the diff and point out problems; don't post anything.`
  }
  const head =
    item.kind === 'issue'
      ? `I'm picking up ${item.url} — ${item.title}. Read it and suggest how to approach it.`
      : `I'm back on ${item.url} — ${item.title}. Tell me where it stands.`
  return [head, ...notes, 'Do not change any code yet.'].join('\n')
}

/** The prompt for a resumed conversation: only what is new, or nothing. */
export function resumePrompt(item: WorkItem): string {
  const notes = prNotes(item)
  return notes.length ? ["I'm back on this.", ...notes].join('\n') : ''
}

/** The branch a transcript's newest record was on, from the file's tail. */
export function lastBranchIn(tail: string): string | null {
  let last: string | null = null
  for (const m of tail.matchAll(/"gitBranch":"((?:[^"\\]|\\.)*)"/g)) last = m[1]
  return last
}
