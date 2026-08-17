import { execFile } from 'child_process'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join, relative } from 'path'

import type { RevertResult, RevertStep } from '../shared/types'
import { canonical, repoRoot } from './git-diff'

/**
 * A restore point per turn, so a turn's edits can be undone as a unit.
 *
 * `git stash create` is what makes it cheap: it writes a commit object holding
 * the whole working tree and touches neither the index nor the stash list, so
 * taking one before every turn costs nothing anybody can see. The commit is
 * unreferenced, so a ref under refs/claude-term/ keeps gc off it.
 */

const TIMEOUT_MS = 10_000
const REF_PREFIX = 'refs/claude-term/checkpoint'

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

/** A file's old bytes, not its text: restoring must be byte-exact, since the
 *  turn may well have edited something that isn't utf-8. */
function gitRaw(cwd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: TIMEOUT_MS, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : (stdout as unknown as Buffer))
    )
  })
}

export interface Checkpoint {
  /** the repository this belongs to */
  root: string
  /** the stash-create commit; null when nothing tracked was modified, in which
   *  case HEAD is the state to restore to */
  sha: string | null
  /** what git was not tracking then. A file in here cannot be restored (its
   *  text was never saved anywhere) and must not be deleted either. */
  untracked: string[]
  at: number
  /** the ref pinning `sha`, so `git gc` cannot drop it */
  ref: string | null
}

/** The commit-ish a file's old text comes from. */
const baseOf = (cp: Checkpoint): string => cp.sha ?? 'HEAD'

/**
 * Snapshot the working tree of `cwd`. Null when it isn't a repository — nothing
 * else in the feature is offered in that case.
 */
export async function takeCheckpoint(cwd: string, id: string): Promise<Checkpoint | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const [created, others] = await Promise.all([
    git(root, ['stash', 'create']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  const sha = created?.trim() || null
  const ref = sha ? `${REF_PREFIX}/${id}` : null
  if (sha && ref) await git(root, ['update-ref', ref, sha])
  return {
    root,
    sha,
    untracked: (others ?? '').split('\0').filter(Boolean),
    at: Date.now(),
    ref
  }
}

/** Let go of a checkpoint's commit — the ref is the only thing holding it. */
export async function dropCheckpoint(cp: Checkpoint): Promise<void> {
  if (cp.ref) await git(cp.root, ['update-ref', '-d', cp.ref])
}

/**
 * What reverting each file means, given what the checkpoint knows about it. Pure
 * so the decision is testable without a repository:
 *
 * - the checkpoint's tree has the file → put that text back
 * - it doesn't, and git wasn't tracking it either → leave it alone; it predates
 *   the turn and its old text was never saved
 * - it doesn't, and it wasn't untracked → the turn created it → delete it
 */
export function planRevert(input: {
  rels: string[]
  inBase: (rel: string) => boolean
  wasUntracked: (rel: string) => boolean
  existsNow: (rel: string) => boolean
}): RevertStep[] {
  return input.rels.map((rel) => {
    if (input.inBase(rel)) return { rel, action: 'restore' }
    if (input.wasUntracked(rel)) return { rel, action: 'keep' }
    return { rel, action: input.existsNow(rel) ? 'remove' : 'keep' }
  })
}

/** Paths of `files` as repo-relative, dropping anything outside the repo. */
export function relsWithin(root: string, files: string[]): string[] {
  const rels: string[] = []
  for (const file of files) {
    const rel = relative(root, canonical(file))
    if (rel && !rel.startsWith('..')) rels.push(rel)
  }
  return rels
}

/**
 * Put the checkpoint's version of `files` back — and only those files. A turn
 * is reverted, not the working tree: anything the user changed by hand
 * meanwhile is none of this function's business.
 */
export async function revertFiles(cp: Checkpoint, files: string[]): Promise<RevertResult> {
  const rels = relsWithin(cp.root, files)
  const base = baseOf(cp)
  const untracked = new Set(cp.untracked)
  const inBase = new Set<string>()
  for (const rel of rels) {
    if ((await git(cp.root, ['cat-file', '-e', `${base}:${rel}`])) !== null) inBase.add(rel)
  }
  const steps = planRevert({
    rels,
    inBase: (rel) => inBase.has(rel),
    wasUntracked: (rel) => untracked.has(rel),
    existsNow: (rel) => existsSync(join(cp.root, rel))
  })
  const done: RevertStep[] = []
  for (const step of steps) {
    const path = join(cp.root, step.rel)
    try {
      if (step.action === 'restore') {
        const bytes = await gitRaw(cp.root, ['cat-file', 'blob', `${base}:${step.rel}`])
        if (bytes === null) {
          done.push({ ...step, action: 'keep' })
          continue
        }
        writeFileSync(path, bytes)
      } else if (step.action === 'remove') {
        unlinkSync(path)
      }
      done.push(step)
    } catch {
      done.push({ ...step, action: 'failed' })
    }
  }
  return { at: cp.at, steps: done }
}
