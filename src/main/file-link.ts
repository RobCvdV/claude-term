import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

import type { FileLink } from '../shared/file-link'
import { insideAny } from './file-tree'

/** Where a `path:line` printed in the terminal actually is on disk. */

function candidates(path: string, roots: string[], home: string): string[] {
  if (path === '~' || path.startsWith('~/')) return [join(home, path.slice(1))]
  if (isAbsolute(path)) return [resolve(path)]
  // Claude prints paths relative to whichever root it was talking about, and a
  // tab can have several — try each in the order the tab lists them.
  return roots.map((root) => resolve(root, path))
}

/**
 * The link resolved to a real file inside one of the tab's roots, or null. Kept
 * inside the roots on purpose: terminal output is not a trusted source, so a
 * printed `/etc/passwd:1` must not become an open file window.
 */
export function resolveFileLink(
  roots: string[],
  link: FileLink,
  home = homedir()
): FileLink | null {
  for (const candidate of candidates(link.path, roots, home)) {
    if (!insideAny(roots, candidate) || !existsSync(candidate)) continue
    try {
      if (!statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    return { ...link, path: candidate }
  }
  return null
}
