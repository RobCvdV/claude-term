/** Whether a mod event may say who holds the tab's keys: background agents
 *  inherit the tab's env and report there too, so only the foreground
 *  (statusline) session counts. */
export function speaksForTab(
  eventSession: unknown,
  foreground: string | null | undefined
): boolean {
  if (!foreground || typeof eventSession !== 'string' || !eventSession) return true
  return eventSession === foreground
}
