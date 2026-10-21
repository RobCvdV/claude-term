/** Prompt and answer handling for "Complete with Claude" — pure, no I/O. */

/** How much of the file around the cursor is sent. */
export const PREFIX_CHARS = 6000
export const SUFFIX_CHARS = 2000

export const COMPLETION_SYSTEM_PROMPT =
  'You complete code and text at a cursor. You get the file name, the text before the ' +
  'cursor in <prefix> and the text after it in <suffix>. Reply with ONLY the text to insert ' +
  'at the cursor — no code fences, no explanation, no repeat of the prefix or suffix. Finish ' +
  'the current statement, block or paragraph; stop where the suffix takes over. If nothing ' +
  'sensible fits, reply with nothing. Every message is a new, separate request — ignore ' +
  'earlier ones.'

export function completionPrompt(path: string, prefix: string, suffix: string): string {
  const before = prefix.length > PREFIX_CHARS ? prefix.slice(-PREFIX_CHARS) : prefix
  const after = suffix.length > SUFFIX_CHARS ? suffix.slice(0, SUFFIX_CHARS) : suffix
  return `File: ${path}\n<prefix>${before}</prefix><suffix>${after}</suffix>`
}

/** The model's reply as insertable text: a wrapping code fence removed, and a
 *  leading echo of the current line's start dropped. */
export function cleanCompletion(reply: string, prefix: string): string {
  let text = reply.replace(/\r\n/g, '\n')
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  if (fenced) text = fenced[1]
  text = text.replace(/^\n+/, (m) => (prefix.endsWith('\n') ? '' : m)).replace(/\s+$/, '')
  const lineStart = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (lineStart.trim() && text.startsWith(lineStart)) text = text.slice(lineStart.length)
  return text
}
