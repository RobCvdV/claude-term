import type { TabStatus } from '../../shared/types'

export interface FolderChip {
  /** full path, for the tooltip */
  path: string
  /** last path segment, for display */
  name: string
}

const strip = (p: string): string => p.replace(/\/+$/, '')
const nameOf = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/**
 * Folders for the status bar: `home` is the tab's own folder (its identity —
 * never re-homed), `others` every distinct additional place the session works
 * in — its live/project dir when the session moved (/cd, or a resume going
 * back to its recorded home) and the added working directories (/add-dir or
 * settings additionalDirectories, via the statusline's added_dirs; the
 * tab-level record is the fallback for payload-less sessions).
 */
export function statusFolders(status: TabStatus | null | undefined): {
  home: FolderChip | null
  others: FolderChip[]
} {
  const cwd = status?.cwd
  if (!cwd) return { home: null, others: [] }
  const p = status?.payload
  const candidates = [
    p?.workspace?.current_dir ?? p?.cwd,
    p?.workspace?.project_dir,
    ...(p?.workspace?.added_dirs ?? status?.addedDirs ?? [])
  ]
  const seen = new Set([strip(cwd)])
  const others: FolderChip[] = []
  for (const dir of candidates) {
    if (!dir || seen.has(strip(dir))) continue
    seen.add(strip(dir))
    others.push({ path: dir, name: nameOf(dir) })
  }
  return { home: { path: cwd, name: nameOf(cwd) }, others }
}
