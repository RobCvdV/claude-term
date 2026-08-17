import { closeSync, fstatSync, openSync, readSync } from 'fs'

import type { ProjectChanges } from '../shared/types'
import { canonical, changedFiles, repoRoot } from './git-diff'
import { transcriptPathFor } from './session-home'
import { turnFiles } from './turn-files'

/** What the diff window shows: the working tree against HEAD, with the files
 *  the current turn wrote to marked out of the rest. */

// Enough to reach back past the last thing the user said in all but the longest
// turns. Falling short only means the turn looks bigger than it was.
const TAIL_BYTES = 1024 * 1024

function readTail(path: string): string | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const stat = fstatSync(fd)
      const len = Math.min(stat.size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, stat.size - len)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export async function projectChanges(
  cwd: string,
  sessionId: string | null
): Promise<ProjectChanges> {
  const [root, files] = await Promise.all([repoRoot(cwd), changedFiles(cwd)])
  const path = sessionId ? transcriptPathFor(sessionId) : null
  const tail = path ? readTail(path) : null
  const turn = tail ? turnFiles(tail) : { files: [], startedAt: null }
  return {
    files,
    // git reports symlink-resolved paths and the transcript reports whatever
    // Claude's cwd looked like, so both sides are canonicalised before the
    // window compares them
    turnFiles: turn.files.map(canonical),
    turnStartedAt: turn.startedAt,
    inRepo: root !== null
  }
}
