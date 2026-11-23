/** The keys a terminal reads, for the macOS editing keys a terminal never sends
 *  (iTerm2's "Natural Text Editing"). Both zsh and Claude Code's input are
 *  readline-style, so the same bytes work in either. */

export interface KeyLike {
  key: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

const META: Record<string, string> = {
  ArrowLeft: '\x01', // ⌃A line start
  ArrowRight: '\x05', // ⌃E line end
  Backspace: '\x15', // ⌃U delete to line start
  Delete: '\x0b', // ⌃K delete to line end
  z: '\x1f' // ⌃_ undo
}

const ALT: Record<string, string> = {
  ArrowLeft: '\x1bb', // ⌥B word left
  ArrowRight: '\x1bf', // ⌥F word right
  Backspace: '\x17', // ⌃W delete word left
  Delete: '\x1bd' // ⌥D delete word right
}

/** What to send for this key, or null to let xterm handle it. `claude`: only
 *  Claude Code reads ⌃J as a newline — zsh would run the line. */
export function macEditingSequence(e: KeyLike, claude: boolean): string | null {
  if (e.ctrlKey) return null
  if (e.metaKey && !e.altKey && !e.shiftKey) return META[e.key] ?? null
  if (e.altKey && !e.metaKey && !e.shiftKey) return ALT[e.key] ?? null
  if (claude && e.shiftKey && !e.metaKey && !e.altKey && e.key === 'Enter') return '\n'
  return null
}
