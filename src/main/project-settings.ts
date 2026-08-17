import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import type { ProjectSettings, ProjectSettingsPatch } from '../shared/types'

/**
 * The app's own per-project settings, kept with the project rather than in the
 * app's profile — so a tab opened in that folder looks the way it did last time,
 * on any machine.
 *
 * `.local.` follows Claude Code's own convention for a file that is personal to
 * one checkout (`settings.local.json`), i.e. a good candidate for .gitignore.
 * Keys we don't know are preserved on write: the file is the user's too.
 */

export const SETTINGS_FILE = join('.claude', 'claude-term-settings.local.json')

const pathFor = (cwd: string): string => join(cwd, SETTINGS_FILE)

/** Only the keys this version understands; the rest ride along untouched. */
function knownSettings(raw: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {}
  if (typeof raw.tabColor === 'string' && raw.tabColor) out.tabColor = raw.tabColor
  return out
}

/** Everything in the file, or null when there is nothing readable there. */
function readRaw(cwd: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(pathFor(cwd), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * A project's settings. `{}` when the file isn't there — indistinguishable from
 * an empty one on purpose, since both mean "nothing configured".
 */
export function readProjectSettings(cwd: string): ProjectSettings {
  const raw = readRaw(cwd)
  return raw ? knownSettings(raw) : {}
}

/**
 * Merge `patch` into the file, a null value removing that key. False when the
 * file is there but unreadable: it may be hand-edited, and overwriting someone's
 * broken JSON with our own idea of the contents would lose their work.
 */
export function writeProjectSettings(cwd: string, patch: ProjectSettingsPatch): boolean {
  const path = pathFor(cwd)
  const existing = existsSync(path) ? readRaw(cwd) : {}
  if (existing === null) return false
  const next: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}
