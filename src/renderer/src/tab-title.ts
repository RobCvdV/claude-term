import type { TabStatus } from '../../shared/types'

const PREFIX_MAP: Record<string, string> = {
  bugfix: 'bug',
  feature: 'feat',
  chore: 'chore'
}

/** bugfix/feature/chore → bug/feat/chore; returns null for any other prefix. */
function shortenBranchPrefix(branch: string): { short: string; rest: string } | null {
  const slash = branch.indexOf('/')
  if (slash === -1) return null
  const short = PREFIX_MAP[branch.slice(0, slash)]
  if (!short) return null
  return { short, rest: branch.slice(slash + 1) }
}

/** Derive the small subtitle shown under a tab title from its git branch. */
export function tabSubtitle(title: string, status: TabStatus | null | undefined): string {
  const branch = status?.git?.branch?.trim()
  if (!branch) return ''
  const parts = shortenBranchPrefix(branch)
  // Personal project / unrecognised prefix → show the full branch name.
  if (!parts) return branch
  const ticket = branch.match(/[A-Z]{2,}-\d+/)
  // Ticket already in the title → drop it from the subtitle, keep the rest.
  if (ticket && title.includes(ticket[0])) {
    const rest = parts.rest
      .replace(ticket[0], '')
      .replace(/^[-/]+/, '')
      .replace(/[-/]+$/, '')
    return rest ? `${parts.short}/${rest}` : parts.short
  }
  // No ticket in the title → full branch with the shortened prefix.
  return `${parts.short}/${parts.rest}`
}

/** One-line title combining a tab's title with its subtitle — used for the
 *  docs window's OS title so it's identifiable as belonging to that tab. */
export function composeWindowTitle(title: string, status: TabStatus | null | undefined): string {
  const subtitle = tabSubtitle(title, status)
  return subtitle ? `${title} — ${subtitle}` : title
}
