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

/**
 * The files written since the last thing the user said. Subagent records count:
 * a file a subagent edited is still a file this turn changed. Unparsable lines
 * are skipped — a transcript is appended to while it is read, so the last line
 * is often half-written.
 */
export function turnFiles(text: string): TurnFiles {
  const records: Record_[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as Record_)
    } catch {
      continue
    }
  }
  let start = 0
  for (let i = records.length - 1; i >= 0; i--) {
    if (isUserMessage(records[i])) {
      start = i
      break
    }
  }
  const files = new Set<string>()
  for (const rec of records.slice(start)) {
    const content = rec.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const path = writtenPath(block)
      if (path) files.add(path)
    }
  }
  const startedAt = records[start]?.timestamp ?? null
  return { files: [...files], startedAt: typeof startedAt === 'string' ? startedAt : null }
}
