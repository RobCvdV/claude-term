/** Search a live session's own conversation, by reading its transcript.
 *
 *  Claude Code draws on the terminal's alternate screen buffer, which keeps no
 *  scrollback — so the conversation above the fold exists only in the session's
 *  transcript. ⌘F searches that instead (see transcript-search.ts for parsing).
 */

import { closeSync, openSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ConvoSearchResult } from '../shared/types'
import { transcriptPathFor } from './session-home'
import { parseTurns, searchTurns, type ConvoTurn } from './transcript-search'

/** A transcript is append-only, so a search re-reads only what was added since
 *  the last one — a busy session's file grows to tens of MB. */
interface Entry {
  /** bytes parsed so far, always ending just past a newline */
  consumed: number
  mtimeMs: number
  turns: ConvoTurn[]
}

/** Transcripts kept parsed in memory (they are large); least-recently searched
 *  is dropped first. */
const MAX_CACHED = 3

const cache = new Map<string, Entry>()

function readRange(path: string, from: number, to: number): Buffer | null {
  const len = to - from
  if (len <= 0) return null
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(len)
      const read = readSync(fd, buf, 0, len, from)
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Parse whole lines from `buf`, and how many bytes that consumed. A trailing
 *  partial record is left for the next read. */
function parseWhole(buf: Buffer): { turns: ConvoTurn[]; consumed: number } {
  const cut = buf.lastIndexOf(0x0a)
  if (cut < 0) return { turns: [], consumed: 0 }
  return { turns: parseTurns(buf.subarray(0, cut).toString('utf8')), consumed: cut + 1 }
}

function turnsFor(path: string): ConvoTurn[] | null {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  const cached = cache.get(path)
  // grown since last time (the common case): parse just the new tail
  if (cached && stat.size >= cached.consumed) {
    if (stat.size === cached.consumed && stat.mtimeMs === cached.mtimeMs) return touch(path, cached)
    const buf = readRange(path, cached.consumed, stat.size)
    if (buf) {
      const { turns, consumed } = parseWhole(buf)
      cached.turns.push(...turns)
      cached.consumed += consumed
    }
    cached.mtimeMs = stat.mtimeMs
    return touch(path, cached)
  }
  // first search, or the file shrank (rewritten) — read it whole. An existing
  // but still empty transcript is a found conversation with nothing in it yet.
  const buf = stat.size > 0 ? readRange(path, 0, stat.size) : Buffer.alloc(0)
  if (!buf) return null
  const { turns, consumed } = parseWhole(buf)
  const entry: Entry = { consumed, mtimeMs: stat.mtimeMs, turns }
  cache.delete(path)
  cache.set(path, entry)
  for (const key of cache.keys()) {
    if (cache.size <= MAX_CACHED) break
    cache.delete(key)
  }
  return entry.turns
}

/** Move to the back of the eviction order. */
function touch(path: string, entry: Entry): ConvoTurn[] {
  cache.delete(path)
  cache.set(path, entry)
  return entry.turns
}

/**
 * Turns of `sessionId`'s conversation containing `query`, newest first.
 * `found` is false when the session has no transcript to search.
 */
export function searchConversation(
  sessionId: string,
  query: string,
  includeTools = false,
  projectsDir = join(homedir(), '.claude', 'projects')
): ConvoSearchResult {
  const empty = { hits: [], total: 0, searched: 0, found: false }
  const path = transcriptPathFor(sessionId, projectsDir)
  if (!path) return empty
  const turns = turnsFor(path)
  if (!turns) return empty
  return { ...searchTurns(turns, query, includeTools), found: true }
}
