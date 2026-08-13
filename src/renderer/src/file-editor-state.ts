/**
 * The rules a file editor window follows about disk text, unsaved drafts and
 * which file is open. Kept apart from the React hook that uses them (and from
 * Monaco) so they can be reasoned about — and tested — on their own.
 */

/** A file's text as last read from (or written to) disk, keyed by its path. */
export interface LoadedFile {
  path: string
  /** null when the file could not be read */
  text: string | null
}

/** The disk text for the open file, or null while it is still loading. Keyed by
 *  path so the previous file's text can never show under a new selection. */
export function contentOf(loaded: LoadedFile | null, path: string | undefined): string | null {
  if (!path || loaded?.path !== path) return null
  return loaded.text
}

/** What the window shows: the unsaved draft when there is one, else disk. */
export function shownText(draft: string | null, content: string | null): string | null {
  return draft ?? content
}

/** There are unsaved edits only when a draft differs from what is on disk.
 *  A draft that matches disk (typed, then undone, or just saved) is not dirty. */
export function isDirty(draft: string | null, content: string | null): boolean {
  return draft != null && draft !== content
}

/** Whether a draft survives moving the selection from `from` to `to`: only when
 *  it is the same file — e.g. a re-scan re-selecting what was already open.
 *  Across files a draft must be dropped, or it would be saved into the wrong
 *  file. */
export function keepsDraft(from: string | undefined, to: string | undefined): boolean {
  return from === to
}

/** What to select after a re-scan: the file that was open if it is still
 *  listed, else the first one (else nothing, when the listing came back empty). */
export function reselect<E extends { path: string }>(
  entries: E[],
  open: string | undefined
): E | null {
  return (open ? entries.find((e) => e.path === open) : undefined) ?? entries[0] ?? null
}
