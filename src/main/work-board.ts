import { homedir } from 'os'
import type {
  BoardCi,
  BranchHistoryEntry,
  ReviewItem,
  TabStatus,
  WorkBoardState,
  WorkContext
} from '../shared/types'
import { fetchMyIssues, ticketsNotMine } from './jira-client'
import { branchTicket } from '../shared/jira-labels'
import { commitStatuses, myWorkspacePrs, recentWorkspaceRepos } from './bitbucket-prs'
import { bitbucketViewer, gh } from './pr-list'
import { bitbucketReposOf } from './review-queue'
import { loginShellEnv } from './shell-env'
import { bitbucketStatusesCi } from './ci-data'
import {
  GITHUB_WORK_QUERY,
  joinWork,
  mapBitbucketMyPrs,
  mapGithubWork,
  mapMyJiraIssues,
  type BoardTicket,
  type SourceIssue,
  type SourcePr
} from './work-board-data'
import { startsFor, type LocalRepo } from './work-start-data'
import { localRepos } from './work-start'

const POLL_MS = 5 * 60_000

interface Sources {
  tickets: BoardTicket[]
  bitbucket: SourcePr[]
  github: { prs: SourcePr[]; issues: SourceIssue[] }
}

/**
 * My open work across Jira, Bitbucket and GitHub for the Work board. Sweeps
 * every 5 minutes while the board is open; a failing source keeps what it
 * last had, and says so in `errors`.
 */
export class WorkBoard {
  private sources: Sources = { tickets: [], bitbucket: [], github: { prs: [], issues: [] } }
  private state: WorkBoardState = { items: [], errors: [], sweptAt: null, sweeping: false }
  /** finished builds per commit never change; running ones are asked again */
  private builds = new Map<string, BoardCi | null>()
  private repos: LocalRepo[] = []
  /** ticket key → who has it, for my PRs whose ticket isn't on my name */
  private handedOff = new Map<string, string>()

  constructor(
    private readonly deps: {
      contexts: () => WorkContext[]
      reviews: () => ReviewItem[]
      snapshots: () => TabStatus[]
      history: () => BranchHistoryEntry[]
      isOpen: () => boolean
      onChange: (state: WorkBoardState) => void
    }
  ) {}

  start(): void {
    setInterval(() => {
      if (this.deps.isOpen()) void this.sweep()
    }, POLL_MS)
  }

  get(): WorkBoardState {
    return this.state
  }

  refresh(): void {
    void this.sweep()
  }

  /** Reviews or settings changed: rebuild the cards without fetching. */
  rejoin(): void {
    this.publish({ items: this.join() })
  }

  private async sweep(): Promise<void> {
    if (this.state.sweeping) return
    this.publish({ sweeping: true })
    const contexts = this.deps.contexts()
    const errors: string[] = []
    const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run()
      } catch (e) {
        errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    }
    const workspaces = [...new Set(contexts.flatMap((c) => c.bitbucketWorkspaces))]
    const [tickets, bitbucket, github, repos] = await Promise.all([
      contexts.some((c) => c.jira)
        ? attempt('Jira', async () => mapMyJiraIssues(await fetchMyIssues()))
        : [],
      workspaces.length ? attempt('Bitbucket', () => this.bitbucketPrs(workspaces)) : [],
      contexts.some((c) => c.github)
        ? attempt('GitHub', async () => {
            const out = await gh(
              ['api', 'graphql', '-f', `query=${GITHUB_WORK_QUERY}`],
              homedir(),
              await loginShellEnv()
            )
            return mapGithubWork(JSON.parse(out))
          })
        : { prs: [], issues: [] },
      localRepos(this.seedRoots())
    ])
    this.repos = repos
    this.sources = {
      tickets: tickets ?? this.sources.tickets,
      bitbucket: bitbucket ?? this.sources.bitbucket,
      github: github ?? this.sources.github
    }
    const mine = new Set(this.sources.tickets.map((t) => t.key))
    const orphans = [...this.sources.bitbucket, ...this.sources.github.prs]
      .map((p) => branchTicket(p.pr.branch))
      .filter((k): k is string => !!k && !mine.has(k))
    if (orphans.length && contexts.some((c) => c.jira)) {
      const others = await attempt('Jira assignees', () => ticketsNotMine([...new Set(orphans)]))
      if (others) this.handedOff = others
    }
    this.publish({ items: this.join(), errors, sweptAt: Date.now(), sweeping: false })
  }

  private join(): WorkBoardState['items'] {
    const contexts = this.deps.contexts()
    const history = this.deps.history()
    return joinWork({
      contexts,
      tickets: this.sources.tickets,
      prs: [...this.sources.bitbucket, ...this.sources.github.prs],
      issues: this.sources.github.issues,
      reviews: this.deps.reviews()
    }).map((item) => ({
      ...item,
      starts: startsFor(item, this.repos, history, contexts),
      handedOff:
        item.kind === 'pr'
          ? (this.handedOff.get(branchTicket(item.prs[0]?.branch ?? '') ?? '') ?? null)
          : null
    }))
  }

  /** Repos a card could start in: every folder a branch was used in, and open tabs'. */
  private seedRoots(): string[] {
    const roots = this.deps.history().map((e) => e.root)
    for (const s of this.deps.snapshots()) roots.push(s.cwd, ...s.extraRepos.map((r) => r.root))
    return [...new Set(roots)]
  }

  private async bitbucketPrs(workspaces: string[]): Promise<SourcePr[]> {
    const me = await this.bitbucketAccount(workspaces)
    if (!me) throw new Error('could not find your account id')
    const lists = await Promise.all(
      workspaces.map(async (ws) => mapBitbucketMyPrs(await myWorkspacePrs(ws, me), ws))
    )
    const prs = lists.flat()
    await Promise.all(
      prs.map(async (src) => {
        if (src.hash) src.pr.ci = await this.build(src.pr.repo, src.hash)
      })
    )
    return prs
  }

  private async build(repo: string, hash: string): Promise<BoardCi | null> {
    const key = `${repo}@${hash}`
    const known = this.builds.get(key)
    if (known !== undefined && known?.state !== 'running') return known
    try {
      const ci = bitbucketStatusesCi(await commitStatuses(repo, hash))
      this.builds.set(key, ci)
      return ci
    } catch {
      return known ?? null
    }
  }

  /** My account id, found through a repo a tab has open or a recently active one. */
  private async bitbucketAccount(workspaces: string[]): Promise<string | null> {
    for (const repo of bitbucketReposOf(this.deps.snapshots()).values()) {
      const id = await bitbucketViewer(repo)
      if (id) return id
    }
    for (const ws of workspaces) {
      for (const repo of await recentWorkspaceRepos(ws)) {
        const id = await bitbucketViewer(repo)
        if (id) return id
      }
    }
    return null
  }

  private publish(patch: Partial<WorkBoardState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.onChange(this.state)
  }
}
