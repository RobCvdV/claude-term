import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { lastAssistantText } from './transcript-tail'
import { bonsaiOneLiner } from './bonsai-client'
import { sanitizeOneLiner } from './bonsai-text'

/** Mission control's one-line "doing" snippet per session, from the tail of
 *  the session's transcript. Short turns show as-is; long ones go through the
 *  local Bonsai model (when up) and fall back to plain truncation. */

const TAIL_BYTES = 64 * 1024
const SNIPPET_LEN = 120

interface CacheEntry {
  mtimeMs: number
  size: number
  value: Promise<string | null>
}

// keyed by transcript path; a new turn changes mtime/size and invalidates
const cache = new Map<string, CacheEntry>()
// sessionId → transcript path; a transcript never moves between projects
// mid-run without the session re-homing, and a miss is re-scanned anyway
const pathCache = new Map<string, string>()

function transcriptPath(sessionId: string, projectsDir: string): string | null {
  const known = pathCache.get(sessionId)
  if (known && existsSync(known)) return known
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const d of dirs) {
    const path = join(projectsDir, d, `${sessionId}.jsonl`)
    if (existsSync(path)) {
      pathCache.set(sessionId, path)
      return path
    }
  }
  return null
}

function readTail(path: string): { text: string; mtimeMs: number; size: number } | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const stat = fstatSync(fd)
      const len = Math.min(stat.size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, stat.size - len)
      return { text: buf.toString('utf8'), mtimeMs: stat.mtimeMs, size: stat.size }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

async function summarize(raw: string, wanted: () => boolean): Promise<string | null> {
  const flat = sanitizeOneLiner(raw, SNIPPET_LEN)
  if (raw.length <= SNIPPET_LEN) return flat
  return (await bonsaiOneLiner(raw, SNIPPET_LEN, wanted)) ?? flat
}

/**
 * One-line snippet of what `sessionId` is working on, or null when there is
 * no transcript (yet). Cached until the transcript grows.
 */
export function sessionDoing(
  sessionId: string,
  wanted: () => boolean = () => true,
  projectsDir = join(homedir(), '.claude', 'projects')
): Promise<string | null> {
  const path = transcriptPath(sessionId, projectsDir)
  if (!path) return Promise.resolve(null)
  const tail = readTail(path)
  if (!tail) return Promise.resolve(null)
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === tail.mtimeMs && hit.size === tail.size) return hit.value
  const raw = lastAssistantText(tail.text)
  const value = raw ? summarize(raw, wanted) : Promise.resolve(null)
  cache.set(path, { mtimeMs: tail.mtimeMs, size: tail.size, value })
  return value
}
