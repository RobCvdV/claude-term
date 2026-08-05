import { readFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

/**
 * additionalDirectories from the project's own settings files. The statusline
 * payload's added_dirs only carries runtime /add-dir entries — settings-sourced
 * working dirs never appear there, so the status bar must learn them from the
 * files. Comment-bearing settings files fail JSON.parse and are skipped.
 */
export function settingsAddedDirs(cwd: string): string[] {
  const out: string[] = []
  for (const file of ['settings.json', 'settings.local.json']) {
    let dirs: unknown
    try {
      const parsed = JSON.parse(readFileSync(join(cwd, '.claude', file), 'utf8')) as {
        permissions?: { additionalDirectories?: unknown }
      }
      dirs = parsed.permissions?.additionalDirectories
    } catch {
      continue
    }
    if (!Array.isArray(dirs)) continue
    for (const d of dirs) {
      if (typeof d !== 'string' || !d) continue
      const expanded = d === '~' || d.startsWith('~/') ? join(homedir(), d.slice(1)) : d
      const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
      if (!out.includes(abs)) out.push(abs)
    }
  }
  return out
}
