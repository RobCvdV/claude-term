/** Which files the current turn touched, read out of a Claude Code transcript.
 *  Pure text in, paths out — the caller does the reading. */

interface ToolBlock {
  type?: string
  name?: string
  input?: { file_path?: string; notebook_path?: string; edits?: unknown }
}

interface Record_ {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  message?: { content?: ToolBlock[] | string }
}

/** The tools that write to disk. A turn's file set is what these were called on. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface TurnFiles {
  /** absolute paths, first touched first, deduped */
  files: string[]
  /** when the turn started (the user's message), if the record carried a time */
  startedAt: string | null
}

/** How far back the turn list goes — the checkpoint store keeps ten. */
export const MAX_TURN_STEPS = 10

/**
 * A record is the start of a turn when it is something the *user* actually
 * said: a plain user message. Tool results come back as `type: 'user'` too, and
 * hook output is flagged `isMeta` — neither begins a turn.
 */
function isUserMessage(rec: Record_): boolean {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false
  const content = rec.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((block) => block.type === 'text')
}

function writtenPath(block: ToolBlock): string | null {
  if (block.type !== 'tool_use' || !block.name || !WRITE_TOOLS.has(block.name)) return null
  return block.input?.file_path ?? block.input?.notebook_path ?? null
}

function parseRecords(text: string): Record_[] {
  const records: Record_[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as Record_)
    } catch {
      // a transcript is appended to while it is read, so the last line is
      // often half-written — and a tail read starts mid-line
      continue
    }
  }
  return records
}

/** Files written by `records` from `start` on. Subagent records count: a file a
 *  subagent edited is still a file that turn changed. */
function writtenFrom(records: Record_[], start: number): string[] {
  const files = new Set<string>()
  for (const rec of records.slice(start)) {
    const content = rec.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const path = writtenPath(block)
      if (path) files.add(path)
    }
  }
  return [...files]
}

/**
 * One step back per turn, newest first: what the last turn wrote, what the last
 * two wrote, and so on. Each step is CUMULATIVE, because that is what undoing
 * "the last three turns" means. Stops at whatever the text reaches back to.
 */
export function turnSteps(text: string, max = MAX_TURN_STEPS): TurnFiles[] {
  const records = parseRecords(text)
  const starts: number[] = []
  for (let i = records.length - 1; i >= 0 && starts.length < max; i--) {
    if (isUserMessage(records[i])) starts.push(i)
  }
  // no user message in view: treat everything we have as the current turn
  if (starts.length === 0) return [{ files: writtenFrom(records, 0), startedAt: null }]
  return starts.map((start) => {
    const at = records[start]?.timestamp
    return {
      files: writtenFrom(records, start),
      startedAt: typeof at === 'string' ? at : null
    }
  })
}

/** The files written since the last thing the user said. */
export function turnFiles(text: string): TurnFiles {
  return turnSteps(text, 1)[0] ?? { files: [], startedAt: null }
}
