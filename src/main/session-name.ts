/**
 * Derive the Claude-session display name for a git branch — the live counterpart
 * of resources/session-name.sh (which does the same at `claude` launch time via
 * `--name`). Keep the two in sync: shorten only the long branch prefixes and
 * always keep the rest of the branch (including the ticket) verbatim.
 *
 *   bugfix/MTX-12345-broken-stuff  → bug/MTX-12345-broken-stuff
 *   feature/MTX-54321-super-thing  → feat/MTX-54321-super-thing
 *   chore/cleanup-logs             → chore/cleanup-logs
 *   fix/prompt-draft-per-tab       → fix/prompt-draft-per-tab   (unknown prefix)
 *   main                           → main
 *
 * Returns null when there is no meaningful branch to name from (no git, detached
 * HEAD) — callers then leave the session's existing/auto-generated name alone.
 */
const PREFIX_MAP: Record<string, string> = {
  bugfix: 'bug',
  feature: 'feat',
  chore: 'chore'
}

export function sessionNameForBranch(branch: string | null | undefined): string | null {
  const b = branch?.trim()
  if (!b || b === 'HEAD') return null
  const slash = b.indexOf('/')
  if (slash === -1) return b
  const short = PREFIX_MAP[b.slice(0, slash)]
  return short ? `${short}/${b.slice(slash + 1)}` : b
}
