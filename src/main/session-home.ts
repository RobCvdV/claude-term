import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

/** Where the session's transcript lives, or null when none exists. */
export function transcriptPathFor(
  sessionId: string,
  projectsDir = join(homedir(), '.claude', 'projects')
): string | null {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  const file = `${sessionId}.jsonl`
  for (const d of dirs) {
    const path = join(projectsDir, d, file)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * The directory a conversation lives in — its project dir, which is what the
 * transcript's parent folder name encodes. `claude --resume` from any other
 * directory re-homes the whole conversation (the CLI moves its transcript to
 * the launch dir), so restore must resume from here — not from wherever the
 * tab happens to spawn.
 *
 * Each record's `cwd` is the session's LIVE shell cwd, which visits other
 * workspace repos as the session works — so the last record's cwd is NOT the
 * home (a multi-repo session that quit while its shell sat in another repo
 * used to get re-homed there on restore). The home is the newest record cwd
 * that encodes to the folder the transcript actually lives in.
 * Null when the transcript is missing, unreadable, or never mentions it.
 */
export function sessionHomeDir(
  sessionId: string,
  projectsDir = join(homedir(), '.claude', 'projects')
): string | null {
  const path = transcriptPathFor(sessionId, projectsDir)
  return path ? homeCwd(path, basename(dirname(path))) : null
}

/** Claude Code's project-folder encoding: every non-alphanumeric char → '-'. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

function homeCwd(path: string, folderName: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && cwd && encodeProjectDir(cwd) === folderName) return cwd
    } catch {
      // partial/corrupt trailing line — keep walking up
    }
  }
  return null
}
