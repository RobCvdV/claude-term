import { existsSync, readdirSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import type { BoardStart, TabId, TabStatus, WorkItem } from '../shared/types'
import { parseRemote, type RepoRef } from '../shared/repo-links'
import { git } from './git-diff'
import { switchBranch } from './git-actions'
import { git as gitOrThrow, startTicket, ticketBranch } from './jira-start'
import { branchTicket } from '../shared/jira-labels'
import { claudeConfigDirIn } from './claude-dir'
import { encodeProjectDir } from './session-home'
import { cardPrompt, lastBranchIn, resumePrompt, type LocalRepo } from './work-start-data'

const remotes = new Map<string, RepoRef | null>()

export async function remoteOf(root: string): Promise<RepoRef | null> {
  if (!remotes.has(root)) {
    const url = await git(root, ['config', '--get', 'remote.origin.url'])
    remotes.set(root, url ? parseRemote(url) : null)
  }
  return remotes.get(root) ?? null
}

/** Git repos next to a known one: clones the app hasn't seen a tab in yet. */
function siblings(parent: string): string[] {
  if (parent === homedir() || parent === '/') return []
  try {
    return (
      readdirSync(parent, { withFileTypes: true })
        // a worktree's .git is a file, a clone's a folder
        .filter((d) => d.isDirectory() && existsSync(join(parent, d.name, '.git')))
        .map((d) => join(parent, d.name))
    )
  } catch {
    return []
  }
}

/** Where a card's worktrees go: `<parent>/.worktrees/<repo>/<branch>`, out of the sibling scan. */
const WORKTREES = '.worktrees'

export const isWorktree = (root: string): boolean => root.includes(`/${WORKTREES}/`)

function worktreesUnder(parent: string): string[] {
  const dir = join(parent, WORKTREES)
  try {
    return readdirSync(dir).flatMap((repo) => siblings(join(dir, repo)))
  } catch {
    return []
  }
}

/** The local clones the app knows of: `seeds` (history, open tabs), their siblings and worktrees. */
export async function localRepos(seeds: string[]): Promise<LocalRepo[]> {
  const roots = new Set(seeds.filter((r) => existsSync(r)))
  for (const parent of new Set([...roots].map(dirname))) {
    for (const r of [...siblings(parent), ...worktreesUnder(parent)]) roots.add(r)
  }
  const found = await Promise.all(
    [...roots].map(async (root) => {
      const ref = await remoteOf(root)
      return ref ? { root, ref } : null
    })
  )
  return found.filter((r): r is LocalRepo => r !== null)
}

const branchIn = (s: TabStatus, root: string): string | undefined =>
  s.cwd === root ? s.git?.branch : s.extraRepos.find((r) => r.root === root)?.git.branch

/** Open tabs working in `root`. */
export function tabsIn(snapshots: readonly TabStatus[], root: string): TabStatus[] {
  return snapshots.filter((s) => branchIn(s, root) !== undefined)
}

/** No turn running, nothing waiting on me, no command or background task. */
function idle(s: TabStatus): boolean {
  const quiet =
    !s.claudeActive || s.activity === 'idle' || s.activity === 'ended' || s.activity === 'exited'
  return quiet && !s.running?.length
}

export type CloneState =
  /** a tab already works on the card's branch here */
  | { kind: 'here'; tabId: TabId }
  | { kind: 'free' }
  /** its own tab sits idle with nothing to commit: reuse that tab */
  | { kind: 'takeover'; tabId: TabId }
  | { kind: 'busy'; why: string }

/** Whether a clone can host the card's session, and how. */
export async function cloneState(
  item: WorkItem,
  start: BoardStart,
  snapshots: readonly TabStatus[]
): Promise<CloneState> {
  const { root } = start
  const key = item.ticket?.key
  const wanted = (b: string | undefined): boolean =>
    !!b && (start.branch ? b === start.branch : !!key && branchTicket(b) === key)
  const users = tabsIn(snapshots, root)
  const here = users.find((s) => wanted(branchIn(s, root)))
  if (here) return { kind: 'here', tabId: here.tabId }
  // a review or issue session stays on whatever is checked out
  if (!key && !start.branch) return { kind: 'free' }
  const working = users.find((s) => !idle(s))
  if (working) return { kind: 'busy', why: `a working tab is on ${branchIn(working, root)}` }
  const current = (await git(root, ['branch', '--show-current']))?.trim() ?? ''
  if (!wanted(current) && (await git(root, ['status', '--porcelain']))) {
    return { kind: 'busy', why: `uncommitted changes on ${current || 'HEAD'}` }
  }
  const own = users.find((s) => s.cwd === root)
  return own ? { kind: 'takeover', tabId: own.tabId } : { kind: 'free' }
}

/** A new worktree of `root` on the card's branch (found, or created for a ticket). */
export async function addWorktree(
  item: WorkItem,
  root: string
): Promise<{ ok: true; start: BoardStart } | { ok: false; error: string }> {
  try {
    let branch = item.prs[0]?.branch ?? ''
    let exists = true
    let base: string | null = null
    if (item.ticket) {
      const { key, type, summary } = item.ticket
      ;({ branch, exists, base } = await ticketBranch(root, key, type, summary))
    } else if (branch) {
      await gitOrThrow(root, ['fetch', 'origin', branch], 30_000).catch(() => {})
    } else {
      return { ok: false, error: 'no branch to check out' }
    }
    const path = join(dirname(root), WORKTREES, basename(root), branch.replace(/[^\w.-]+/g, '-'))
    if (!existsSync(path)) {
      const add = exists
        ? ['worktree', 'add', path, branch]
        : [
            'worktree',
            'add',
            ...(base ? ['--no-track'] : []),
            '-b',
            branch,
            path,
            ...(base ? [base] : [])
          ]
      await gitOrThrow(root, add, 60_000)
    }
    return { ok: true, start: { root: path, branch, sure: true } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Conversations older than this are not worth resuming. */
const RESUME_MAX_AGE_MS = 30 * 24 * 3600_000
const TAIL_BYTES = 256 * 1024

async function tailOf(path: string, size: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

/** The newest conversation in `root` that was last on `branch`, unless a tab has it open. */
export async function lastSessionOn(
  root: string,
  branch: string,
  openIds: ReadonlySet<string>,
  now = Date.now()
): Promise<string | null> {
  const dir = join(await claudeConfigDirIn(root), 'projects', encodeProjectDir(root))
  let files: { id: string; path: string; mtime: number; size: number }[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const st = statSync(join(dir, f))
        return { id: f.slice(0, -6), path: join(dir, f), mtime: st.mtimeMs, size: st.size }
      })
  } catch {
    return null
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files) {
    if (now - f.mtime > RESUME_MAX_AGE_MS) break
    if (openIds.has(f.id)) continue
    try {
      if (lastBranchIn(await tailOf(f.path, f.size)) === branch) return f.id
    } catch {
      // unreadable transcript: try the next one
    }
  }
  return null
}

export type PreparedStart =
  | { ok: true; cwd: string; prompt: string; resume: string | null; warnings: string[] }
  | { ok: false; error: string }

/**
 * Put `start.root` on the card's branch (cloneState said it may) and build the
 * first prompt. The last conversation on the branch is resumed rather than a
 * new one started. `note` is added to a new session's prompt.
 */
export async function prepareStart(
  item: WorkItem,
  start: BoardStart,
  snapshots: readonly TabStatus[],
  note = ''
): Promise<PreparedStart> {
  const { root } = start
  const openSessions = new Set(snapshots.map((s) => s.sessionId).filter((id): id is string => !!id))
  const withNote = (prompt: string): string => (note ? `${prompt}\n\n${note}` : prompt)
  const resumed = async (
    branch: string,
    fresh: string,
    warnings: string[]
  ): Promise<PreparedStart> => {
    const resume = await lastSessionOn(root, branch, openSessions)
    const prompt = resume ? resumePrompt(item) : withNote(fresh)
    return { ok: true, cwd: root, prompt, resume, warnings }
  }

  if (item.ticket) {
    const res = await startTicket(root, item.ticket.key, null, item.ticket.category === 'todo')
    if (!res.ok) return res
    const fresh = cardPrompt(item, res.prompt)
    if (res.created) {
      return { ok: true, cwd: root, prompt: withNote(fresh), resume: null, warnings: res.warnings }
    }
    return resumed(res.branch, fresh, res.warnings)
  }
  const current = (await git(root, ['branch', '--show-current']))?.trim() ?? ''
  if (start.branch && start.branch !== current) {
    await git(root, ['fetch', 'origin', start.branch])
    const res = await switchBranch(root, start.branch)
    if (!res.ok) return { ok: false, error: res.error ?? 'git switch failed' }
  }
  if (start.branch) return resumed(start.branch, cardPrompt(item, null), [])
  return {
    ok: true,
    cwd: root,
    prompt: withNote(cardPrompt(item, null)),
    resume: null,
    warnings: []
  }
}
