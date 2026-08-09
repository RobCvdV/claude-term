/** Extract "what is this session doing" from the tail of a Claude Code
 *  transcript (*.jsonl). Pure text-in/text-out, no I/O. */

interface ContentBlock {
  type?: string
  text?: string
}

interface TranscriptRecord {
  type?: string
  isSidechain?: boolean
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
