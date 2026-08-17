import { execFile } from 'child_process'
import { realpathSync } from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'

import type { ChangedFile, FileChangeKind } from '../shared/types'

/** The working tree against HEAD: what changed, and each file's two sides. */

const TIMEOUT_MS = 10_000
/** A diff editor is for reading, not for a 40 MB minified bundle. */
const MAX_DIFF_BYTES = 2_000_000

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

/**
 * A path with its symlinks resolved, which is the form git reports: on macOS a
 * project under /tmp or any symlinked folder otherwise looks like it sits
 * outside its own repository. Missing segments are kept as they are, so a file
 * the turn just deleted still canonicalises.
 */
export function canonical(path: string): string {
  let head = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(path)
      tail.unshift(basename(head))
      head = parent
    }
  }
}

/** The repository a folder is in. Null when it isn't in one. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel'])
  return out ? out.trim() || null : null
}

// Porcelain's two status letters, index then worktree. Only the interesting
// distinctions survive: what the diff editor needs is which side to read.
function kindOf(code: string): FileChangeKind {
  if (code === '??') return 'untracked'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  if (code.includes('R')) return 'renamed'
  return 'modified'
}

function parseStatus(out: string): { rel: string; kind: FileChangeKind }[] {
  const files: { rel: string; kind: FileChangeKind }[] = []
  for (const record of out.split('\0')) {
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    // "XY path" — a rename also lists its old path in the next record, which
    // has no status letters of its own and is skipped by the length check above
    files.push({ rel: record.slice(3), kind: kindOf(code) })
  }
  return files
}

function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>()
  for (const record of out.split('\0')) {
    const parts = record.split('\t')
    if (parts.length < 3) continue
    const [added, removed] = parts
    // a rename's record carries several paths; the file it is now is the last
    const rel = parts[parts.length - 1]
    counts.set(rel, {
      // "-" is git's marker for a binary file
      added: added === '-' ? 0 : Number(added) || 0,
      removed: removed === '-' ? 0 : Number(removed) || 0
    })
  }
  return counts
}

/**
 * Every file that differs from HEAD, including files git isn't tracking yet.
 * Paths come back absolute; the counts are git's own, so a binary file reads 0/0.
 */
export async function changedFiles(cwd: string): Promise<ChangedFile[]> {
  const root = await repoRoot(cwd)
  if (!root) return []
  const [status, numstat] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['diff', '--numstat', '-z', 'HEAD'])
  ])
  if (status === null) return []
  const counts = parseNumstat(numstat ?? '')
  return parseStatus(status).map(({ rel, kind }) => ({
    path: join(root, rel),
    rel,
    kind,
    added: counts.get(rel)?.added ?? 0,
    removed: counts.get(rel)?.removed ?? 0
  }))
}

/**
 * A file's text at HEAD — the left side of the diff. Null when HEAD has no such
 * file (it was just added) or it is too big to be worth showing.
 */
export async function fileAtHead(cwd: string, path: string): Promise<string | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const rel = relative(root, canonical(path))
  if (!rel || rel.startsWith('..')) return null
  const out = await git(root, ['show', `HEAD:${rel}`])
  if (out === null) return null
  return out.length > MAX_DIFF_BYTES ? null : out
}
