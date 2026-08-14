/** Finding a file anywhere in the project, for the file window's filter box.
 *
 *  The window's rail lists what it curates — markdown and configuration files —
 *  so a `notes` or a `Makefile` is only in the tree. Typing in the filter box
 *  searches every file under the window's roots instead, which is how anything
 *  the rail doesn't list is still reachable by name. */

import { statSync } from 'fs'
import { join } from 'path'
import type { TreeNode } from '../shared/types'
import { matchesFilter } from '../shared/glob-match'
import { listFiles } from './completions'

/** Hits handed to the window per query — enough to find something by name,
 *  few enough that a one-letter query stays a list rather than a dump. */
const MAX_HITS = 40

/** Files under `roots` matching `query` (see matchesFilter: substring, or a
 *  pattern once it has a `*`). Shortest path first, so the closest match to
 *  what was typed leads. Empty for an empty query — the rail shows itself. */
export async function findFiles(roots: string[], query: string): Promise<TreeNode[]> {
  if (!query.trim()) return []
  const hits: TreeNode[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    for (const rel of await listFiles(root)) {
      if (!matchesFilter(query, rel)) continue
      const path = join(root, rel)
      if (seen.has(path)) continue
      seen.add(path)
      hits.push({ path, name: rel, isDir: false, size: sizeOf(path) })
    }
  }
  hits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
  return hits.slice(0, MAX_HITS)
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    // vanished between listing and stat — the window's own read will report it
    return 0
  }
}
