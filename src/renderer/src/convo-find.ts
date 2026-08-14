/** Turning conversation hits into rows: what to show, and where the query sits
 *  in it. Pure — the find bar does the DOM part. */

import type { ConvoHit, ConvoMatch, ConvoRole } from '../../shared/types'

/** A run of text, matched or not, ready to render. */
export interface Segment {
  text: string
  hit: boolean
}

/** Text around the first match on one line, with the offsets moved to match. */
export interface Preview {
  text: string
  matches: ConvoMatch[]
}

/** Chars of a hit shown in its row before the window is cut off. */
const PREVIEW_CHARS = 160
/** Kept in front of the first match, so the row shows what led up to it. */
const PREVIEW_LEAD = 32

const ROLE_LABELS: Record<ConvoRole, string> = {
  user: 'you',
  claude: 'claude',
  tool: 'tool',
  thinking: 'thinking'
}

/** Who said it — a tool turn names the tool where the transcript recorded one. */
export function roleLabel(hit: Pick<ConvoHit, 'role' | 'tool'>): string {
  return hit.role === 'tool' && hit.tool ? hit.tool : ROLE_LABELS[hit.role]
}

/** Split `text` into plain and matching runs, in order and gap-free. */
export function segments(text: string, matches: ConvoMatch[]): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const m of matches) {
    const start = Math.max(at, m.start)
    if (start >= m.end) continue // an earlier match already covered this one
    if (start > at) out.push({ text: text.slice(at, start), hit: false })
    out.push({ text: text.slice(start, m.end), hit: true })
    at = m.end
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

/**
 * A one-line window on a hit for its row in the result list: newlines flattened
 * (offsets stay put — one char for one char), cut around the first match, with
 * `…` where text was dropped.
 */
export function previewOf(hit: ConvoHit, width = PREVIEW_CHARS): Preview {
  const flat = hit.text.replace(/\s/g, ' ')
  const first = hit.matches[0]?.start ?? 0
  let from = Math.max(0, first - PREVIEW_LEAD)
  // a hit near the end of a short turn: use the room in front of it
  if (from > 0 && flat.length - from < width) from = Math.max(0, flat.length - width)
  const to = from + width
  const slice = flat.slice(from, to)
  const body = slice.trim()
  // trimming the window moves every offset in it along with it
  const start = from + (slice.length - slice.trimStart().length)
  const end = start + body.length
  // `…` means text was dropped — trimmed whitespace does not count
  const lead = from > 0 || hit.clipped ? '…' : ''
  const tail = to < flat.length || hit.clipped ? '…' : ''
  const shift = lead.length - start
  return {
    text: lead + body + tail,
    matches: hit.matches
      .filter((m) => m.start >= start && m.end <= end)
      .map((m) => ({ start: m.start + shift, end: m.end + shift }))
  }
}

/** Next/previous hit, wrapping around; -1 while nothing is selected. */
export function stepHit(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return -1
  return (((current < 0 ? 0 : current + dir) % count) + count) % count
}
