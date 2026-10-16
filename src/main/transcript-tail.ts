/** Extract "what is this session doing" from the tail of a Claude Code
 *  transcript (*.jsonl). Pure text-in/text-out, no I/O. */

interface ContentBlock {
  type?: string
  text?: string
}

interface TranscriptRecord {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  lastPrompt?: string
  message?: { content?: ContentBlock[] | string }
}

/**
 * The last assistant-visible text in a transcript tail: newest record wins,
 * sidechains (subagent chatter) and thinking/tool-only records are skipped.
 * The first line handed in may be cut mid-record — parse failures just walk on.
 */
export function lastAssistantText(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let rec: TranscriptRecord
    try {
      rec = JSON.parse(line) as TranscriptRecord
    } catch {
      continue
    }
    if (rec.type !== 'assistant' || rec.isSidechain) continue
    const content = rec.message?.content
    if (typeof content === 'string') {
      if (content.trim()) return content.trim()
      continue
    }
    if (!Array.isArray(content)) continue
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b]
      if (block.type === 'text' && block.text?.trim()) return block.text.trim()
    }
  }
  return null
}

/** What the user last asked: Claude Code's own `last-prompt` record, else the
 *  newest typed user message (tool results and <command> wrappers skipped). */
export function lastUserPrompt(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let rec: TranscriptRecord
    try {
      rec = JSON.parse(line) as TranscriptRecord
    } catch {
      continue
    }
    if (rec.type === 'last-prompt' && rec.lastPrompt?.trim()) return rec.lastPrompt.trim()
    if (rec.type !== 'user' || rec.isSidechain || rec.isMeta) continue
    const content = rec.message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.find((b) => b.type === 'text')?.text
          : undefined
    if (text?.trim() && !text.trim().startsWith('<')) return text.trim()
  }
  return null
}
