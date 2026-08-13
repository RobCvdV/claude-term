import { readdirSync, statSync } from 'fs'
import { basename, resolve, sep } from 'path'
import type { TreeNode, TreeRoot } from '../shared/types'

/**
 * The project file tree behind the docs window's rail: the folders it is rooted
 * at, and one level of a folder at a time. Nothing recursive — a folder is read
 * only when it is expanded, so a large repo costs nothing until it is browsed.
 */

/** Directories never worth walking: dependencies, build output, IDE caches. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.cache',
  '.turbo',
  '.next',
  '.venv',
  '__pycache__',
  'DerivedData',
  'Pods',
  'vendor',
  'target',
  '.gradle',
  '.dart_tool',
  // Delphi build/backup droppings
  '__history',
  '__recovery'
])

/** Is `path` inside one of `roots` (or one of them itself)? */
export function insideAny(roots: string[], path: string): boolean {
  const p = resolve(path)
  return roots.some((root) => {
    const r = resolve(root)
    return p === r || p.startsWith(r + sep)
  })
}

/** The folders the tree is rooted at: the tab's own cwd first, then each added
 *  directory that isn't already inside an earlier root. Roots other than the
 *  cwd carry their absolute path, since two can share a folder name. */
export function treeRoots(cwd: string, addedDirs: string[]): TreeRoot[] {
  const roots: TreeRoot[] = [{ path: resolve(cwd), name: basename(cwd) || cwd }]
  for (const dir of addedDirs) {
    const path = resolve(dir)
    if (
      insideAny(
        roots.map((r) => r.path),
        path
      )
    )
      continue
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    roots.push({ path, name: basename(path) || path, subtitle: path })
  }
  return roots
}

/** One level of `dir`: folders first, then files, each alphabetical. Dot-folders
 *  are kept — `.claude` and `.github` are worth reaching — and only the skip
 *  list is left out. Refuses any directory outside `roots`.
 *
 *  Symlinks are left out too: one pointing outside the roots would be a folder
 *  the window then refuses to open, and one pointing at an ancestor makes a
 *  tree with no bottom. Only real files and folders are offered. */
export function listTree(roots: string[], dir: string): TreeNode[] {
  if (!insideAny(roots, dir)) return []
  let items: import('fs').Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: TreeNode[] = []
  for (const item of items) {
    const isDir = item.isDirectory()
    if (isDir && SKIP_DIRS.has(item.name)) continue
    if (!isDir && !item.isFile()) continue
    const path = resolve(dir, item.name)
    let size = 0
    if (!isDir) {
      try {
        size = statSync(path).size
      } catch {
        continue // vanished between readdir and stat
      }
    }
    nodes.push({ path, name: item.name, isDir, size })
  }
  nodes.sort(
    (a, b) =>
      Number(b.isDir) - Number(a.isDir) ||
      a.name.localeCompare(b.name, undefined, { numeric: true })
  )
  return nodes
}
