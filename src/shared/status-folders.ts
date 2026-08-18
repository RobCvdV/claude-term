import type { TabStatus } from './types'

export interface FolderChip {
  /** full path, for the tooltip */
  path: string
  /** last path segment, for display */
  name: string
}

const strip = (p: string): string => p.replace(/\/+$/, '')

/** noisy repo-name prefixes to drop in the display name (longest first) */
const PREFIXES = ['mendrix-mobile-', 'mendrix-', 'eyo-cordova-']

/** Display name for a workspace folder: last segment, noisy prefixes dropped. */
export const nameOf = (p: string): string => {
  const base = p.split('/').filter(Boolean).pop() ?? p
  for (const pre of PREFIXES) {
    if (base.startsWith(pre) && base.length > pre.length) return base.slice(pre.length)
  }
  return base
}

/** Distinct chips for these paths, skipping anything already `seen`. */
function chips(dirs: (string | undefined)[], seen: Set<string>): FolderChip[] {
  const out: FolderChip[] = []
  for (const dir of dirs) {
    if (!dir || seen.has(strip(dir))) continue
    seen.add(strip(dir))
    out.push({ path: dir, name: nameOf(dir) })
  }
  return out
}

/**
 * The extra folders of a session — `/add-dir`'d or settings-sourced, never a
 * /cd move. These are the removable ones: what `/remove-dir` completes over and
 * what the folder chip's context menu offers to drop.
 *
 * Two sources merged: the statusline's `added_dirs` (runtime `/add-dir` only)
 * and the tab-level record (which also carries settings-sourced
 * additionalDirectories — those never appear in the payload). Anything the user
 * removed is filtered out of both, or it would come straight back.
 */
export function addedFolders(status: TabStatus | null | undefined): FolderChip[] {
  const cwd = status?.cwd
  if (!cwd) return []
  const removed = new Set((status?.removedDirs ?? []).map(strip))
  const dirs = [...(status?.payload?.workspace?.added_dirs ?? []), ...(status?.addedDirs ?? [])]
  return chips(
    dirs.filter((d) => !removed.has(strip(d))),
    new Set([strip(cwd)])
  )
}

/**
 * Folders for the status bar: `home` is the tab's own folder (its identity —
 * never re-homed), `others` every distinct additional place the session works
 * in — its live/project dir when the session moved (/cd), plus the extra
 * folders (see addedFolders).
 */
export function statusFolders(status: TabStatus | null | undefined): {
  home: FolderChip | null
  others: FolderChip[]
} {
  const cwd = status?.cwd
  if (!cwd) return { home: null, others: [] }
  const p = status?.payload
  const seen = new Set([strip(cwd)])
  const moved = chips([p?.workspace?.current_dir ?? p?.cwd, p?.workspace?.project_dir], seen)
  const added = addedFolders(status).filter((f) => !seen.has(strip(f.path)))
  for (const f of added) seen.add(strip(f.path))
  return { home: { path: cwd, name: nameOf(cwd) }, others: [...moved, ...added] }
}

/**
 * Which extra folder an argument means: a full path, or the folder name as the
 * UI shows it (display name or last segment), case-insensitively. Returns the
 * folder's real path, or null when nothing matches unambiguously.
 */
export function matchExtraDir(arg: string, extras: readonly FolderChip[]): string | null {
  const q = strip(arg.trim())
  if (!q) return null
  const exact = extras.find((f) => strip(f.path) === q)
  if (exact) return exact.path
  const lower = q.toLowerCase()
  const byName = extras.filter(
    (f) =>
      f.name.toLowerCase() === lower ||
      (f.path.split('/').filter(Boolean).pop() ?? '').toLowerCase() === lower
  )
  return byName.length === 1 ? byName[0].path : null
}
