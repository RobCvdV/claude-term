/** What the diff window lists, and which of it the turn is responsible for.
 *  Pure — the view renders these. */

import type { ChangedFile, FileChangeKind, ProjectChanges } from '../../shared/types'

/** Which changes are on screen: only what the last turn wrote, or everything
 *  that differs from HEAD. */
export type DiffScope = 'turn' | 'all'

/** One letter per change kind, the way `git status --short` reads. */
export function changeBadge(kind: FileChangeKind): string {
  switch (kind) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'untracked':
      return 'U'
    default:
      return 'M'
  }
}

/** Did the current turn write this file? */
export function inTurn(changes: ProjectChanges, file: ChangedFile): boolean {
  return changes.turnFiles.includes(file.path)
}

export function scopedFiles(changes: ProjectChanges, scope: DiffScope): ChangedFile[] {
  if (scope === 'all') return changes.files
  return changes.files.filter((f) => inTurn(changes, f))
}

/**
 * Open on the turn's own changes when it made any — that is the question being
 * asked ("what did it just do?"). A turn that only read files, or a window
 * opened between turns, falls back to the whole working tree.
 */
export function initialScope(changes: ProjectChanges): DiffScope {
  return scopedFiles(changes, 'turn').length > 0 ? 'turn' : 'all'
}

/** Keep the open file if it is still listed, else take the first. */
export function reselectChange(files: ChangedFile[], openPath?: string): ChangedFile | null {
  return files.find((f) => f.path === openPath) ?? files[0] ?? null
}

/** `+12 −3` totals for a heading. */
export function totals(files: ChangedFile[]): { added: number; removed: number } {
  return files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 }
  )
}

/** Why the pane is empty, or null when it isn't. */
export function emptyReason(changes: ProjectChanges, scope: DiffScope): string | null {
  if (!changes.inRepo) return 'This folder is not in a git repository.'
  if (changes.files.length === 0) return 'Nothing has changed since the last commit.'
  if (scopedFiles(changes, scope).length === 0) return 'This turn did not change any files.'
  return null
}
