import type { GitMark, GitMarks } from './types'

/** The git colour of one tree row: its own status, else what a folder above it
 *  says for everything inside (ignored, untracked), else — for a folder — that
 *  something below it changed. */
export function markFor(
  marks: GitMarks | null,
  dirty: ReadonlySet<string>,
  path: string,
  isDir: boolean
): GitMark | undefined {
  if (!marks) return undefined
  const own = marks.exact[path]
  if (own) return own
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const above = marks.exact[path.slice(0, i)]
    if (above === 'ignored' || above === 'untracked') return above
  }
  return isDir && dirty.has(path) ? 'modified' : undefined
}
