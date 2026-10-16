import { execFile } from 'child_process'
import type { ReviewItem, TabStatus } from '../shared/types'
import { parseRemote, type RepoRef } from '../shared/repo-links'
import { bitbucketGet } from './bitbucket-api'
import { mapBitbucketReviews, mapGithubReviews } from './pr-data'
import { bitbucketViewer } from './pr-list'
import { loginShellEnv } from './shell-env'

const POLL_MS = 5 * 60_000

/**
 * Open PRs waiting on my review: one Bitbucket request per repo the tabs have
 * open, one GitHub search in total. Polls every 5 minutes while enabled and a
 * window is on screen; a PR that turns up after the first sweep is news.
 */
export class ReviewQueue {
  private items: ReviewItem[] = []
  private timer: NodeJS.Timeout | null = null
  private swept = false
  private sweeping = false

  constructor(
    private readonly snapshots: () => TabStatus[],
    private readonly isActive: () => boolean,
    private readonly isEnabled: () => boolean,
    private readonly onChange: (items: ReviewItem[], added: ReviewItem[]) => void
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), POLL_MS)
    setTimeout(() => void this.sweep(), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): ReviewItem[] {
    return this.items
  }

  /** e.g. the setting just came on */
  refresh(): void {
    void this.sweep(true)
  }

  private async sweep(force = false): Promise<void> {
    if (this.sweeping) return
    if (!this.isEnabled()) {
      if (this.items.length) this.onChange((this.items = []), [])
      this.swept = false
      return
    }
    if (!force && !this.isActive()) return
    this.sweeping = true
    try {
      const repos = new Map<string, RepoRef>()
      for (const snap of this.snapshots()) {
        for (const git of [snap.git, ...snap.extraRepos.map((r) => r.git)]) {
          const repo = git?.remoteUrl ? parseRemote(git.remoteUrl) : null
          if (repo?.host === 'bitbucket') repos.set(`${repo.owner}/${repo.repo}`, repo)
        }
      }
      const found: ReviewItem[] = []
      let failed = false
      for (const [name, repo] of repos) {
        try {
          found.push(...(await bitbucketReviews(repo, name)))
        } catch {
          failed = true
        }
      }
      try {
        found.push(...(await githubReviews()))
      } catch {
        failed = true
      }
      // a failed fetch keeps what it had for that host rather than "nothing waiting"
      const next = failed && found.length === 0 ? this.items : found
      const known = new Set(this.items.map((i) => i.url))
      const added = this.swept ? next.filter((i) => !known.has(i.url) && !i.myVerdict) : []
      const changed =
        next.length !== this.items.length ||
        next.some(
          (i, n) => i.url !== this.items[n]?.url || i.myVerdict !== this.items[n]?.myVerdict
        )
      this.items = next
      this.swept = true
      if (changed) this.onChange(next, added)
    } finally {
      this.sweeping = false
    }
  }
}

async function bitbucketReviews(repo: RepoRef, name: string): Promise<ReviewItem[]> {
  const me = await bitbucketViewer(repo)
  if (!me) return []
  const params = new URLSearchParams({
    q: `state="OPEN" AND reviewers.account_id="${me}"`,
    pagelen: '20',
    fields:
      'values.id,values.title,values.links.html.href,values.author.display_name,' +
      'values.participants.user.account_id,values.participants.approved,values.participants.state'
  })
  const body = await bitbucketGet(`/repositories/${repo.owner}/${repo.repo}/pullrequests`, params)
  return mapBitbucketReviews(body, name, me)
}

async function githubReviews(): Promise<ReviewItem[]> {
  const env = await loginShellEnv()
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      'gh',
      [
        'search',
        'prs',
        '--review-requested=@me',
        '--state=open',
        '--limit',
        '20',
        '--json',
        'number,title,url,repository,author'
      ],
      { env, timeout: 15_000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
  if (out === null) throw new Error('gh search prs failed')
  return mapGithubReviews(out)
}
