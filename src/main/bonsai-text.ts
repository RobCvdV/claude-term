/** Text hygiene for output of the local Bonsai model — a small, lossy model
 *  whose replies must never reach the UI unchecked. Pure, no I/O. */

/** Flatten a model reply to one clean line of at most `maxLen` chars.
 *  Null when nothing usable remains — callers fall back to raw text. */
export function sanitizeOneLiner(raw: string | null | undefined, maxLen = 120): string | null {
  if (!raw) return null
  let s = raw.replace(/\s+/g, ' ').trim()
  // strip a wrapping quote pair and label prefixes the model likes to add
  s = s.replace(/^["'“”]+|["'“”]+$/g, '')
  s = s.replace(/^(summary|answer|one-liner|doing)\s*:\s*/i, '')
  s = s.replace(/\*\*/g, '').trim()
  if (!s) return null
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…'
  return s
}

/** Hard cap on text sent to the model — the tail of a long turn is what
 *  matters, so keep the end, not the start. */
export function clipForModel(text: string, maxChars = 2000): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}
