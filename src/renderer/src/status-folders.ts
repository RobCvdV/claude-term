import type { TabStatus } from '../../shared/types'

export interface FolderChip {
  /** full path, for the tooltip */
  path: string
  /** last path segment, for display */
  name: string
}

const strip = (p: string): string => p.replace(/\/+$/, '')

/** noisy repo-name prefixes to drop in the display name (longest first) */
const PREFIXES = ['mendrix-mobile-', 'mendrix-', 'eyo-cordova-']

const nameOf = (p: string): string => {
  const base = p.split('/').filter(Boolean).pop() ?? p
  for (const pre of PREFIXES) {
    if (base.startsWith(pre) && base.length > pre.length) return base.slice(pre.length)
  }
  return base
}

/**
 * Folders for the status bar: `home` is the tab's own folder (its identity —
 * never re-homed), `others` every distinct additional place the session works
 * in — its live/project dir when the session moved (/cd), the statusline's
 * added_dirs (runtime /add-dir only), and the tab-level record (which also
 * carries settings-sourced additionalDirectories: those never appear in the
 * payload, so both sources are merged).
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
    ...(p?.workspace?.added_dirs ?? []),
    ...(status?.addedDirs ?? [])
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
