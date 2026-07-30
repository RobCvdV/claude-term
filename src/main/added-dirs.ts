import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'

/**
 * The extra working directories of a Claude session — what `/add-dir` and
 * `permissions.additionalDirectories` add on top of the cwd. The Settings
 * window lists each as its own section.
 *
 * Claude Code keeps no readable record of a runtime `/add-dir`: it is absent
 * from the statusline payload, from the session transcript, and from
 * ~/.claude.json. So there are exactly two sources, and we use both:
 *
 *  1. `permissions.additionalDirectories` in the settings chain — static, and
 *     the only thing that survives independently of this app.
 *  2. `/add-dir <path>` submitted through the app's prompt box, sniffed as it
 *     passes through the main process.
 *
 * KNOWN GAP: `/add-dir` typed straight into the terminal bypasses the prompt
 * box and cannot be observed. Put it in `permissions.additionalDirectories` to
 * make it stick.
 */

/** Settings files Claude Code merges, lowest precedence first. All optional. */
function settingsChain(cwd: string): string[] {
  return [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json')
  ]
}

interface SettingsFile {
  permissions?: { additionalDirectories?: unknown }
}

/** `permissions.additionalDirectories` across the settings chain, in order. */
export function additionalDirectoriesFromSettings(cwd: string): string[] {
  const out: string[] = []
  for (const file of settingsChain(cwd)) {
    let parsed: SettingsFile
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as SettingsFile
    } catch {
      continue // missing or malformed — a broken settings file must not break us
    }
    const dirs = parsed.permissions?.additionalDirectories
    if (!Array.isArray(dirs)) continue
    for (const d of dirs) if (typeof d === 'string') out.push(d)
  }
  return out
}

/** Strip one layer of matching quotes, as typed on a shell-ish command line. */
function unquote(arg: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(arg)
  return m ? m[2] : arg
}

/** Absolute form of a `/add-dir` argument: `~` expanded, relative to `cwd`. */
export function resolveAddedDir(arg: string, cwd: string): string | null {
  const raw = unquote(arg.trim())
  if (!raw) return null
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

/**
 * The directory a submitted prompt adds, or null if it isn't an `/add-dir`.
 * Only the first line is considered — `/add-dir` is a command, so anything
 * after a newline is a separate message rather than part of the path.
 */
export function addedDirFromPrompt(text: string, cwd: string): string | null {
  const firstLine = text.split('\n', 1)[0]
  const m = /^\s*\/add-dir\s+(.+)$/.exec(firstLine)
  if (!m) return null
  return resolveAddedDir(m[1], cwd)
}

/**
 * Every extra directory for a tab: the ones we saw submitted, merged with the
 * settings chain's. Order is preserved (observed first), duplicates and
 * non-existent paths dropped.
 */
export function mergeAddedDirs(cwd: string, observed: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const fromSettings = additionalDirectoriesFromSettings(cwd).map(
    (d) => resolveAddedDir(d, cwd) ?? d
  )
  for (const dir of [...observed, ...fromSettings]) {
    const abs = resolve(dir)
    if (seen.has(abs) || !existsSync(abs)) continue
    seen.add(abs)
    out.push(abs)
  }
  return out
}
