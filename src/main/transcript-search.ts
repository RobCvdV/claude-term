/** Turn a Claude Code transcript (*.jsonl) into searchable turns, and search
 *  them. Pure text-in/data-out, no I/O — see conversation-search.ts for that. */

import {
  MAX_CONVO_HIT_CHARS,
  MAX_CONVO_HITS,
  type ConvoHit,
  type ConvoMatch,
  type ConvoRole,
  type ConvoSearchResult
} from '../shared/types'

/** One searchable turn: one content block of one transcript record. */
export interface ConvoTurn {
  role: ConvoRole
  tool?: string
  time: string | null
  text: string
}

interface Block {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
}

interface Record {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  timestamp?: string
  message?: { content?: Block[] | string }
}

/** Matches within a window of this many chars before the first match are kept
 *  in view, so a hit deep inside a long turn still shows its context. */
const LEAD_IN_CHARS = 240

const MATCHES_PER_HIT = 100

/** JSON plumbing, of no use to someone reading a hit. */
const SKIP_KEYS = new Set(['type', 'tool_use_id', 'is_error', 'signature'])
const BARE_KEYS = new Set(['text', 'content'])

/**
 * Every turn in the transcript, oldest first. A record with several content
 * blocks (thinking, then an answer, then a tool call) becomes several turns, so
 * a hit points at the block that actually matched. Unparsable lines are skipped
 * — the file is appended to while we read it, so the last line is often partial.
 */
export function parseTurns(text: string): ConvoTurn[] {
  const turns: ConvoTurn[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: Record
    try {
      rec = JSON.parse(trimmed) as Record
    } catch {
      continue
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    const time = typeof rec.timestamp === 'string' ? rec.timestamp : null
    // machine-injected text (hook output, system reminders, `/`-command echoes)
    // is not something anyone said — it sits in the tool bucket
    const machine = Boolean(rec.isMeta || rec.isSidechain)
    const said: ConvoRole = rec.type === 'user' ? 'user' : 'claude'
    const content = rec.message?.content
    if (typeof content === 'string') {
      push(turns, { role: machine ? 'tool' : said, time, text: content })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text')
        push(turns, { role: machine ? 'tool' : said, time, text: block.text ?? '' })
      else if (block.type === 'thinking')
        push(turns, { role: 'thinking', time, text: block.thinking ?? '' })
      else if (block.type === 'tool_use')
        push(turns, { role: 'tool', tool: block.name, time, text: flatten(block.input) })
      else if (block.type === 'tool_result')
        push(turns, { role: 'tool', time, text: flatten(block.content) })
    }
  }
  return turns
}

function push(turns: ConvoTurn[], turn: ConvoTurn): void {
  if (turn.text.trim()) turns.push(turn)
}

/** Tool inputs and results are free-form JSON; searching them means searching
 *  their text, with the nesting flattened away. */
function flatten(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('\n')
  const parts: string[] = []
  for (const [key, val] of Object.entries(value as object)) {
    if (SKIP_KEYS.has(key)) continue
    const flat = flatten(val)
    if (!flat) continue
    // name the field, except where the name is just plumbing ("text: ...")
    parts.push(BARE_KEYS.has(key) || typeof val === 'object' ? flat : `${key}: ${flat}`)
  }
  return parts.join('\n')
}

/** Which turns a scope searches: the conversation, or everything in it. */
export function inScope(turn: ConvoTurn, includeTools: boolean): boolean {
  return includeTools || turn.role === 'user' || turn.role === 'claude'
}

/**
 * Turns containing `query` (case-insensitive, plain substring), newest first
 * and capped — `total` reports how many matched before the cap. Long turns come
 * back as a window around their first match rather than whole.
 */
export function searchTurns(
  turns: ConvoTurn[],
  query: string,
  includeTools = false
): Omit<ConvoSearchResult, 'found'> {
  const searched = turns.filter((t) => inScope(t, includeTools)).length
  if (!query.trim()) return { hits: [], total: 0, searched }
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const hits: ConvoHit[] = []
  let total = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (!inScope(turn, includeTools)) continue
    const matches = matchesIn(turn.text, re)
    if (!matches.length) continue
    total++
    if (hits.length < MAX_CONVO_HITS) hits.push(clip(turn, i, matches))
  }
  return { hits, total, searched }
}

function matchesIn(text: string, re: RegExp): ConvoMatch[] {
  re.lastIndex = 0
  const found: ConvoMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    found.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) re.lastIndex++ // an empty query would never advance
    if (found.length >= MATCHES_PER_HIT) break
  }
  return found
}

function clip(turn: ConvoTurn, index: number, matches: ConvoMatch[]): ConvoHit {
  const hit: ConvoHit = {
    index,
    role: turn.role,
    time: turn.time,
    text: turn.text,
    clipped: false,
    matches
  }
  if (turn.tool) hit.tool = turn.tool
  if (turn.text.length <= MAX_CONVO_HIT_CHARS) return hit
  let from = Math.max(0, matches[0].start - LEAD_IN_CHARS)
  // a match near the end of the turn: take the room in front of it instead
  if (turn.text.length - from < MAX_CONVO_HIT_CHARS)
    from = Math.max(0, turn.text.length - MAX_CONVO_HIT_CHARS)
  const to = from + MAX_CONVO_HIT_CHARS
  hit.text = turn.text.slice(from, to)
  hit.clipped = true
  hit.matches = matches
    .filter((m) => m.start >= from && m.end <= to)
    .map((m) => ({ start: m.start - from, end: m.end - from }))
  return hit
}
