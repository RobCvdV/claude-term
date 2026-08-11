import { readFileSync, writeFileSync } from 'fs'
import type { BranchHistoryEntry } from '../shared/types'

/** Long-lived branches everyone is always "on" — not worth recalling. */
const SKIP = new Set(['HEAD', 'main', 'master', 'develop'])
const KEEP = 200
/** A checked-out branch is re-reported on every git poll — only rewrite the
 *  file when its recency actually moved by this much. */
const MIN_BUMP_MS = 60_000

/**
 * Persistent history of branches seen checked out in any tab's workspace
 * (JSON in userData), so the ⌘K palette can recall work from weeks ago —
 * open tabs only cover today.
 */
export class BranchHistory {
  private entries: BranchHistoryEntry[] | null = null

  constructor(private readonly file: () => string) {}

  private load(): BranchHistoryEntry[] {
    if (this.entries) return this.entries
    let parsed: BranchHistoryEntry[] = []
    try {
      const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as unknown
      if (Array.isArray(raw)) {
        parsed = raw.filter(
          (e): e is BranchHistoryEntry =>
            !!e &&
            typeof e.root === 'string' &&
            typeof e.branch === 'string' &&
            typeof e.lastUsed === 'number'
        )
      }
    } catch {
      /* first run or corrupt file — start empty */
    }
    parsed.sort((a, b) => b.lastUsed - a.lastUsed)
    this.entries = parsed.slice(0, KEEP)
    return this.entries
  }

  /** A branch is checked out in `root` right now — remember/refresh it. */
  record(root: string, branch: string, now = Date.now()): void {
    if (SKIP.has(branch)) return
    const all = this.load()
    const existing = all.find((e) => e.root === root && e.branch === branch)
    if (existing && now - existing.lastUsed < MIN_BUMP_MS) return
    if (existing) existing.lastUsed = now
    else all.push({ root, branch, lastUsed: now })
    all.sort((a, b) => b.lastUsed - a.lastUsed)
    this.entries = all.slice(0, KEEP)
    try {
      writeFileSync(this.file(), JSON.stringify(this.entries))
    } catch {
      /* best effort */
    }
  }

  /** Merge historical sightings (a repo's reflog): unknown branches are
   *  inserted with their reflog time, known ones never lose recency. */
  backfill(root: string, found: { branch: string; lastUsed: number }[]): void {
    const all = this.load()
    let changed = false
    for (const f of found) {
      if (SKIP.has(f.branch)) continue
      const existing = all.find((e) => e.root === root && e.branch === f.branch)
      if (existing) {
        if (f.lastUsed > existing.lastUsed) {
          existing.lastUsed = f.lastUsed
          changed = true
        }
      } else {
        all.push({ root, branch: f.branch, lastUsed: f.lastUsed })
        changed = true
      }
    }
    if (!changed) return
    all.sort((a, b) => b.lastUsed - a.lastUsed)
    this.entries = all.slice(0, KEEP)
    try {
      writeFileSync(this.file(), JSON.stringify(this.entries))
    } catch {
      /* best effort */
    }
  }

  /** Most recently used first. */
  recent(limit = 100): BranchHistoryEntry[] {
    return this.load().slice(0, limit)
  }
}
