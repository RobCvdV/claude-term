/**
 * Window titles start with a fixed word naming the kind of window, so window
 * managers, switchers and scripts can tell the app's windows apart by title
 * alone. Everything that changes — the project, the branch, the open file —
 * follows it, and never replaces it.
 */
export const WINDOW_KIND = {
  /** the app's own window: tabs, terminals, prompt box */
  main: 'Terminal',
  /** the detached viewer/editor (docs, settings, the file tree) */
  files: 'File editor'
} as const

/** `Kind — part — part`, dropping the parts that are empty. */
export function windowTitle(
  kind: (typeof WINDOW_KIND)[keyof typeof WINDOW_KIND],
  ...parts: (string | null | undefined)[]
): string {
  return [kind, ...parts.map((p) => p?.trim()).filter(Boolean)].join(' — ')
}
