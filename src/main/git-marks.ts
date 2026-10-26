import { dirname, join } from 'path'
import type { GitMark, GitMarks } from '../shared/types'
import { canonical, git, repoRoot } from './git-diff'

/** How git sees the files under the file window's roots, for the tree's colours. */

function markOf(code: string): GitMark | null {
  if (code === '!!') return 'ignored'
  if (code === '??') return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict'
  if (code.includes('D')) return null // gone from disk — nothing in the tree to colour
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** `git status --porcelain=v1 -z` as repo-relative paths. A folder git reports
 *  whole (`?? new/`, `!! dist/`) loses its trailing slash; a deleted file is
 *  kept as `null`, since its folder still changed. */
export function parseMarks(out: string): Map<string, GitMark | null> {
  const marks = new Map<string, GitMark | null>()
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    marks.set(record.slice(3).replace(/\/$/, ''), markOf(code))
    // a rename or copy is followed by its old path, which has no status of its own
    if (code.includes('R') || code.includes('C')) i++
  }
  return marks
}

/** The git marks of every repository the roots are in, keyed by the paths the
 *  tree shows (the roots' own spelling, not git's symlink-resolved one). */
export async function gitMarks(roots: string[]): Promise<GitMarks> {
  const exact: Record<string, GitMark> = {}
  const dirty = new Set<string>()
  const byTop = new Map<string, string[]>()
  for (const root of roots) {
    const top = await repoRoot(root)
    if (top) byTop.set(top, [...(byTop.get(top) ?? []), root])
  }
  for (const [top, inRepo] of byTop) {
    const out = await git(top, ['status', '--porcelain=v1', '-z', '--ignored=matching'])
    if (out === null) continue
    const mapped = inRepo.map((root) => ({ root, real: canonical(root) }))
    for (const [rel, mark] of parseMarks(out)) {
      const real = join(top, rel)
      const hit = mapped.find(({ real: r }) => real === r || real.startsWith(r + '/'))
      if (!hit) continue
      const path = hit.root + real.slice(hit.real.length)
      if (mark) exact[path] = mark
      if (mark === 'ignored') continue
      for (let dir = dirname(path); dir.length >= hit.root.length; dir = dirname(dir)) {
        if (dirty.has(dir)) break
        dirty.add(dir)
        if (dir === hit.root) break
      }
    }
  }
  return { exact, dirty: [...dirty] }
}
