/** What to call "show this file in the OS file manager", per platform — the
 *  wording people expect is the file manager's own name. */
export function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Show in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in files'
}
