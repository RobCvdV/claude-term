import { execFile } from 'child_process'

/** A branch sighting recovered from a repo's reflog. */
export interface ReflogBranch {
  branch: string
  /** epoch ms of the newest reflog entry that mentions the branch */
  lastUsed: number
}

const CHECKOUT_RE = /^HEAD@\{(\d+)\} checkout: moving from (\S+) to (\S+)$/
/** a detached checkout's target is a commit hash, not a branch */
const HASH_RE = /^[0-9a-f]{7,40}$/

/**
 * Extract per-branch last-used times from `git reflog --date=unix
 * --format='%gd %gs'` output (newest first). Both sides of a checkout count:
 * at that moment the target starts being used and the source was in use
 * until then.
 */
export function parseReflog(output: string): ReflogBranch[] {
  const seen = new Map<string, number>()
  for (const line of output.split('\n')) {
    const m = CHECKOUT_RE.exec(line.trim())
    if (!m) continue
    const at = parseInt(m[1], 10) * 1000
    for (const branch of [m[2], m[3]]) {
      if (HASH_RE.test(branch)) continue
      if (!seen.has(branch)) seen.set(branch, at)
    }
  }
  return [...seen.entries()].map(([branch, lastUsed]) => ({ branch, lastUsed }))
}

/** Branches recoverable from a repo's reflog; empty for non-repos/errors. */
export function reflogBranches(root: string): Promise<ReflogBranch[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-C',
        root,
        'reflog',
        '--date=unix',
        '--format=%gd %gs',
        '-n',
        '1000'
      ],
      { timeout: 4_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parseReflog(stdout))
    )
  })
}
