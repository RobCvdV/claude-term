import type { Finding } from './protocol'

// Harper's own spelling rules are dropped: our hunspell pass already owns
// spelling, in Dutch as well as English, and knows the jargon in
// spell/tech-words.ts plus whatever the user added. Harper knows none of that,
// so its spelling lints would be noise on top of markers we already draw.
const IGNORED_KINDS = new Set(['Spelling'])

/**
 * Trim a lint run down to what's worth drawing: real spans, no spelling, and one
 * marker per region — Harper can report several rules over the same words, and
 * stacked squiggles just make the hover unreadable.
 */
export function usableFindings(findings: Finding[]): Finding[] {
  const kept: Finding[] = []
  for (const f of [...findings].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (IGNORED_KINDS.has(f.kind)) continue
    if (f.end <= f.start) continue
    const last = kept[kept.length - 1]
    if (last && f.start < last.end) continue // overlaps the one we already kept
    kept.push(f)
  }
  return kept
}
