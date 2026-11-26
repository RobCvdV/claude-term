import type { BoardDigestItem } from 'claude-term-protocol'
import type { TabStatus, WorkItem } from '../../shared/types'
import { boardDrift, laneOf, mergeable, sessionFor, urgency } from '../../shared/work-board'

/** A briefing, not the whole board: the most pressing first. */
export const MAX_DIGEST = 8

/** Why an item needs you, in the words an assistant would use, most pressing first. */
export function reasonsFor(item: WorkItem, session: TabStatus | null): string[] {
  const reasons: string[] = []
  if (session?.claudeActive && session.activity === 'needs-attention') {
    reasons.push('its session is waiting on a prompt')
  }
  if (item.warning) reasons.push(item.warning)
  if (item.review && !item.review.myVerdict) {
    reasons.push(`review requested by ${item.review.author}`)
  }
  for (const pr of item.prs) {
    const name = `PR #${pr.number}`
    if (pr.ci?.state === 'failed') reasons.push(`${name}: ${pr.ci.name} failed`)
    if (pr.review === 'changes') reasons.push(`${name}: changes requested`)
    if (mergeable(pr)) reasons.push(`${name}: approved, ready to merge`)
  }
  const drift = boardDrift(item)
  if (drift) reasons.push(drift.text)
  return reasons
}

/** The Work board items in "Needs you", for Claudia to go through. */
export function boardDigest(items: WorkItem[], sessions: readonly TabStatus[]): BoardDigestItem[] {
  return items
    .map((item) => ({ item, session: sessionFor(item, sessions) }))
    .filter(({ item, session }) => laneOf(item, session) === 'needs-you')
    .sort((a, b) => urgency(b.item, b.session) - urgency(a.item, a.session))
    .slice(0, MAX_DIGEST)
    .map(({ item, session }) => ({
      id: item.id,
      // PR titles often carry the key already: "[MTX-1] Fix it"
      title:
        item.ticket && !item.title.includes(item.ticket.key)
          ? `${item.ticket.key} ${item.title}`
          : item.title,
      reasons: reasonsFor(item, session),
      url: item.url,
      tabId: session?.tabId ?? null
    }))
}
