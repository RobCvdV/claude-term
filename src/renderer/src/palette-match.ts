// Fuzzy matching for the command palette: case-insensitive subsequence match
// with word-start and adjacency bonuses. Dependency-free on purpose.

const WORD_BOUNDARY = /[\s\-_/.:]/

/**
 * Score `query` as a subsequence of `text`; null when it doesn't match.
 * Word-start hits (3) beat adjacent hits (2) beat scattered hits (1); gaps
 * cost a little, and shorter targets win ties.
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    const idx = t.indexOf(ch, from)
    if (idx === -1) return null
    const wordStart = idx === 0 || WORD_BOUNDARY.test(t[idx - 1])
    score += wordStart ? 3 : idx === prev + 1 ? 2 : 1
    score -= Math.min(idx - from, 3) * 0.1
    prev = idx
    from = idx + 1
  }
  return score - t.length * 0.01
}

/** Best score of `query` across several searchable fields; null = no field matches. */
export function bestScore(query: string, fields: (string | undefined)[]): number | null {
  let best: number | null = null
  for (const field of fields) {
    if (!field) continue
    const s = matchScore(query, field)
    if (s !== null && (best === null || s > best)) best = s
  }
  return best
}
