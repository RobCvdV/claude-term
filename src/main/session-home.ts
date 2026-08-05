import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * The directory a conversation lives in: the cwd of its last transcript
 * record. `claude --resume` from any other directory re-homes the whole
 * conversation (the CLI moves its transcript to the launch dir), so restore
 * must resume from here — not from wherever the tab happens to spawn.
 * Null when the transcript is missing or unreadable.
 */
export function sessionHomeDir(
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
    if (existsSync(path)) return lastCwd(path)
  }
  return null
}

function lastCwd(path: string): string | null {
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
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      // partial/corrupt trailing line — keep walking up
    }
  }
  return null
}
