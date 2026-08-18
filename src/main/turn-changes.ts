import { closeSync, fstatSync, openSync, readSync } from 'fs'

import type { ProjectChanges } from '../shared/types'
import { canonical, changedFiles, repoRoot } from './git-diff'
import { transcriptPathFor } from './session-home'
import { turnSteps } from './turn-files'

/** What the diff window shows: the working tree against HEAD, with the files
 *  the current turn wrote to marked out of the rest. */

// Enough to reach back past the last few things the user said in all but the
// longest turns. Falling short only means fewer turns are offered to undo.
const TAIL_BYTES = 4 * 1024 * 1024

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
  const steps = tail ? turnSteps(tail) : []
  return {
    files,
    // git reports symlink-resolved paths and the transcript reports whatever
    // Claude's cwd looked like, so both sides are canonicalised before the
    // window compares them
    turns: steps.map((step, i) => ({
      depth: i + 1,
      startedAt: step.startedAt,
      files: step.files.map(canonical),
      // filled in by the caller, which is the side that knows the checkpoints
      revertable: false
    })),
    inRepo: root !== null
  }
}
