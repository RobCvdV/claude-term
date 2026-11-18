import { homedir } from 'os'
import type { BoardCi, ReviewItem, TabStatus, WorkBoardState, WorkContext } from '../shared/types'
import { fetchMyIssues } from './jira-client'
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

  constructor(
    private readonly deps: {
      contexts: () => WorkContext[]
      reviews: () => ReviewItem[]
      snapshots: () => TabStatus[]
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
    const [tickets, bitbucket, github] = await Promise.all([
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
        : { prs: [], issues: [] }
    ])
    this.sources = {
      tickets: tickets ?? this.sources.tickets,
      bitbucket: bitbucket ?? this.sources.bitbucket,
      github: github ?? this.sources.github
    }
    this.publish({ items: this.join(), errors, sweptAt: Date.now(), sweeping: false })
  }

  private join(): WorkBoardState['items'] {
    return joinWork({
      contexts: this.deps.contexts(),
      tickets: this.sources.tickets,
      prs: [...this.sources.bitbucket, ...this.sources.github.prs],
      issues: this.sources.github.issues,
      reviews: this.deps.reviews()
    })
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
