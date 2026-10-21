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
  // claude trims its answer, so `n` + ` % 2` arrives as `n%2`-glued: put the
  // space back between a word and an operator or another word
  if (/[\w)\]]$/.test(prefix) && /^[\w%+\-*/=<>!&|?^]/.test(text)) text = ' ' + text
  return text
}

/** Context sent around a selection to edit. */
export const EDIT_BEFORE_CHARS = 4000
export const EDIT_AFTER_CHARS = 2000

export const EDIT_SYSTEM_PROMPT =
  'You edit part of a file. You get the file name, the text before the selection in ' +
  '<before>, the selection in <selection>, the text after it in <after>, and an instruction. ' +
  'Reply with ONLY the new text that replaces the selection — no code fences, no explanation, ' +
  'nothing from <before> or <after>. Keep the indentation and style of the file. Every ' +
  'message is a new, separate request — ignore earlier ones.'

export function editPrompt(
  path: string,
  before: string,
  selection: string,
  after: string,
  instruction: string
): string {
  const b = before.length > EDIT_BEFORE_CHARS ? before.slice(-EDIT_BEFORE_CHARS) : before
  const a = after.length > EDIT_AFTER_CHARS ? after.slice(0, EDIT_AFTER_CHARS) : after
  return (
    `File: ${path}\n<before>${b}</before><selection>${selection}</selection>` +
    `<after>${a}</after>\nInstruction: ${instruction}`
  )
}

/** The reply as a drop-in replacement: a wrapping code fence removed, and the
 *  selection's own trailing newline kept or left off to match. */
export function cleanEdit(reply: string, selection: string): string {
  let text = reply.replace(/\r\n/g, '\n')
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  if (fenced) text = fenced[1]
  text = text.replace(/\s+$/, '')
  const tail = /\n+$/.exec(selection)?.[0] ?? ''
  return text + tail
}
