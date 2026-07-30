// Pull the words worth spell-checking out of editor text.
//
// Prose in this app is mixed with things a dictionary can never know: file
// paths, slash commands, @mentions, identifiers, markdown code. Every one of
// those would squiggle, and a spell checker that cries wolf gets switched off —
// so the extraction is deliberately conservative: anything that smells like code
// is dropped rather than checked.

export type SpellMode = 'prompt' | 'markdown'

export interface WordHit {
  /** 1-based, as Monaco counts lines */
  line: number
  /** 1-based start column of the word */
  column: number
  word: string
}

const WORD = /\p{L}+(?:['’]\p{L}+)*/gu
const CHUNK = /\S+/g
// surrounding punctuation only — digits must survive, they are the tell for
// `utf8`, `v2`, `MTX-10302` and friends
const EDGE_LEAD = /^[^\p{L}\p{N}]+/u
const EDGE_TRAIL = /[^\p{L}\p{N}]+$/u

/** Blank out a span, keeping its length so columns still line up. */
function mask(text: string, pattern: RegExp): string {
  return text.replace(pattern, (m) => ' '.repeat(m.length))
}

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi
const INLINE_CODE = /`+[^`]*`+/g
const LINK_TARGET = /\]\([^)]*\)/g
const HTML_TAG = /<[^\s>][^>]*>/g
const AT_MENTION = /(^|\s)@\S+/g
const FENCE = /^\s*(```|~~~)/

/** Everything code-ish that survives inside an otherwise prose chunk. */
const CODEY = /[\d_@:/\\]|\.\p{L}/u

/**
 * Extract the checkable words from a model's full text.
 *
 * `mode` decides which non-prose spans get skipped: markdown code fences and
 * link targets for the docs editor, the leading slash command for the prompt.
 */
export function extractWords(text: string, mode: SpellMode): WordHit[] {
  const hits: WordHit[] = []
  const lines = text.split('\n')
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]

    if (mode === 'markdown') {
      if (FENCE.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      line = mask(line, INLINE_CODE)
      line = mask(line, LINK_TARGET)
      line = mask(line, HTML_TAG)
    } else {
      // a slash command is the app's own vocabulary, not prose
      if (i === 0) line = mask(line, /^\/\S+/)
      line = mask(line, AT_MENTION)
    }
    line = mask(line, URL_LIKE)

    CHUNK.lastIndex = 0
    let chunk: RegExpExecArray | null
    while ((chunk = CHUNK.exec(line))) {
      const core = chunk[0].replace(EDGE_LEAD, '').replace(EDGE_TRAIL, '')
      // one code-ish character condemns the whole chunk: `foo.bar`, `v2`,
      // `MTX-10302`, `src/main` are units, not words that happen to touch.
      if (!core || CODEY.test(core)) continue

      WORD.lastIndex = 0
      let word: RegExpExecArray | null
      while ((word = WORD.exec(chunk[0]))) {
        if (!isCheckable(word[0])) continue
        hits.push({ line: i + 1, column: chunk.index + word.index + 1, word: word[0] })
      }
    }
  }
  return hits
}

/** Acronyms and camelCase are names, not misspellings. */
function isCheckable(word: string): boolean {
  if (word.length < 3) return false
  if (!/\p{Ll}/u.test(word)) return false // TMS, API, IPC
  if (/\p{Lu}/u.test(word.slice(1))) return false // PromptBox, macOS
  return true
}
