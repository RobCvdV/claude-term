import { homedir } from 'os'
import type {
  BoardCi,
  BranchHistoryEntry,
  ReviewItem,
  StartPlan,
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
  excludedStatus,
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
import { lastSessionOn, listWorktrees, localRepos, planStart } from './work-start'

const POLL_MS = 5 * 60_000
/** a first baseline soon after launch, so changes notify from the next sweep on */
const FIRST_SWEEP_MS = 30_000

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
  private state: WorkBoardState = {
    items: [],
    worktrees: [],
    errors: [],
    sweptAt: null,
    sweeping: false
  }
  /** finished builds per commit never change; running ones are asked again */
  private builds = new Map<string, BoardCi | null>()
  private repos: LocalRepo[] = []
  /** ticket key → who has it, for my PRs whose ticket isn't on my name */
  private handedOff = new Map<string, string>()
  private plans = new Map<string, StartPlan | null>()
  /** `root\nbranch` → a conversation to resume there; cleared each sweep */
  private resumable = new Map<string, boolean>()
  private planning: Promise<void> | null = null
  private planAgain = false

  constructor(
    private readonly deps: {
      contexts: () => WorkContext[]
      reviews: () => ReviewItem[]
      snapshots: () => TabStatus[]
      history: () => BranchHistoryEntry[]
      isOpen: () => boolean
      /** sweep while the board is closed too */
      watching: () => boolean
      onChange: (state: WorkBoardState) => void
      /** fresh results of a sweep */
      onSwept: (items: WorkBoardState['items']) => void
    }
  ) {}

  start(): void {
    const tick = (): void => {
      if (this.deps.isOpen() || this.deps.watching()) void this.sweep()
    }
    setTimeout(tick, FIRST_SWEEP_MS)
    setInterval(tick, POLL_MS)
  }

  get(): WorkBoardState {
    return this.state
  }

  refresh(): void {
    void this.sweep()
  }

  /** The board as of at most `maxAgeMs` ago, sweeping first when it is older. */
  async current(maxAgeMs: number): Promise<WorkBoardState> {
    const at = this.state.sweptAt
    if (!at || Date.now() - at > maxAgeMs) await this.sweep()
    return this.state
  }

  /** Reviews or settings changed: rebuild the cards without fetching. */
  rejoin(): void {
    this.publish({ items: this.join() })
  }

  /** Tabs changed: work out again what ▶ session would do, and which worktrees are in use. */
  replan(): void {
    if (this.planning) {
      this.planAgain = true
      return
    }
    this.planning = this.plan()
      .catch(() => {})
      .finally(() => {
        this.planning = null
        if (this.planAgain) {
          this.planAgain = false
          this.replan()
        }
      })
  }

  private async plan(): Promise<void> {
    const snaps = this.deps.snapshots()
    const open = new Set(snaps.map((s) => s.sessionId).filter((id): id is string => !!id))
    const resumable = async (root: string, branch: string): Promise<boolean> => {
      const key = `${root}\n${branch}`
      if (!this.resumable.has(key)) {
        this.resumable.set(key, !!(await lastSessionOn(root, branch, open)))
      }
      return this.resumable.get(key)!
    }
    const items = this.join()
    const plans = await Promise.all(
      items.map((i) => planStart(i, snaps, resumable).catch(() => null))
    )
    this.plans = new Map(items.map((item, n) => [item.id, plans[n]]))
    const prs = [...this.sources.bitbucket, ...this.sources.github.prs]
    const worktrees = await listWorktrees(
      this.repos,
      snaps,
      new Set(prs.map((p) => p.pr.branch)),
      this.activeTickets()
    )
    this.publish({ items: this.join(), worktrees })
  }

  /** My tickets still on the board (not past Deploy / Beta / Done). */
  private activeTickets(): Set<string> {
    const jira = this.deps.contexts().find((c) => c.jira)?.jira
    return new Set(
      this.sources.tickets
        .filter((t) => !jira || !excludedStatus(t.status, jira.excludeStatuses))
        .map((t) => t.key)
    )
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
    this.resumable.clear()
    this.publish({ items: this.join(), errors, sweptAt: Date.now(), sweeping: false })
    this.deps.onSwept(this.state.items)
    this.replan()
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
          : null,
      plan: this.plans.get(item.id) ?? null
    }))
  }

  /** The local clones found on the last sweep. */
  projects(): LocalRepo[] {
    return this.repos
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
