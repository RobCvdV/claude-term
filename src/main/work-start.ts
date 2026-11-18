import { existsSync, readdirSync, statSync } from 'fs'
import { open } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import type { BoardStart, TabId, TabStatus, WorkItem } from '../shared/types'
import { parseRemote, type RepoRef } from '../shared/repo-links'
import { git } from './git-diff'
import { switchBranch } from './git-actions'
import { startTicket } from './jira-start'
import { claudeConfigDirIn } from './claude-dir'
import { encodeProjectDir } from './session-home'
import { cardPrompt, lastBranchIn, resumePrompt, type LocalRepo } from './work-start-data'

const remotes = new Map<string, RepoRef | null>()

async function remoteOf(root: string): Promise<RepoRef | null> {
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
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(parent, d.name, '.git')))
      .map((d) => join(parent, d.name))
  } catch {
    return []
  }
}

/** The local clones the app knows of: `seeds` (history, open tabs) and their siblings. */
export async function localRepos(seeds: string[]): Promise<LocalRepo[]> {
  const roots = new Set(seeds.filter((r) => existsSync(r)))
  for (const parent of new Set([...roots].map(dirname))) {
    for (const r of siblings(parent)) roots.add(r)
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
  | { ok: true; tabId: TabId }
  | { ok: true; cwd: string; prompt: string; resume: string | null; warnings: string[] }
  | { ok: false; error: string }

/**
 * Put `start.root` on the card's branch and build the first prompt. Refuses a
 * clone another tab works in, or one with uncommitted changes on another
 * branch; a tab already on the branch is returned instead. The last
 * conversation on the branch is resumed rather than a new one started.
 */
export async function prepareStart(
  item: WorkItem,
  start: BoardStart,
  snapshots: readonly TabStatus[]
): Promise<PreparedStart> {
  const { root } = start
  const name = basename(root)
  const users = tabsIn(snapshots, root)
  const here = start.branch ? users.find((s) => branchIn(s, root) === start.branch) : undefined
  if (here) return { ok: true, tabId: here.tabId }
  if (users.length) return { ok: false, error: `${name} is in use by another tab` }

  const current = (await git(root, ['branch', '--show-current']))?.trim() ?? ''
  const switching = item.ticket !== null || start.branch !== null
  if (switching && start.branch !== current && (await git(root, ['status', '--porcelain']))) {
    return { ok: false, error: `${name} has uncommitted changes on ${current || 'HEAD'}` }
  }

  const openSessions = new Set(snapshots.map((s) => s.sessionId).filter((id): id is string => !!id))
  const resumed = async (
    branch: string,
    fresh: string,
    warnings: string[]
  ): Promise<PreparedStart> => {
    const resume = await lastSessionOn(root, branch, openSessions)
    return { ok: true, cwd: root, prompt: resume ? resumePrompt(item) : fresh, resume, warnings }
  }

  if (item.ticket) {
    const res = await startTicket(root, item.ticket.key, null, item.ticket.category === 'todo')
    if (!res.ok) return res
    const fresh = cardPrompt(item, res.prompt)
    if (res.created)
      return { ok: true, cwd: root, prompt: fresh, resume: null, warnings: res.warnings }
    return resumed(res.branch, fresh, res.warnings)
  }
  if (start.branch && start.branch !== current) {
    await git(root, ['fetch', 'origin', start.branch])
    const res = await switchBranch(root, start.branch)
    if (!res.ok) return { ok: false, error: res.error ?? 'git switch failed' }
  }
  if (start.branch) return resumed(start.branch, cardPrompt(item, null), [])
  return { ok: true, cwd: root, prompt: cardPrompt(item, null), resume: null, warnings: [] }
}
