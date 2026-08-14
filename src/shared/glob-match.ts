/**
 * Filter matching for file lists: plain text matches anywhere, and `*` / `?`
 * turn the query into a pattern.
 *
 * Without a wildcard a query is a substring — the forgiving thing to type while
 * looking for a file. With one it is a pattern, matched against the whole path
 * *and* against the file name alone, so `*.md` finds `docs/plan.md` by its path
 * and `plan*` finds it by its name.
 */

const WILDCARD = /[*?]/

/** Does `text` (a path) satisfy `query`? Case-insensitive; empty matches all. */
export function matchesFilter(query: string, text: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const t = text.toLowerCase()
  if (!WILDCARD.test(q)) return t.includes(q)
  const re = patternFor(q)
  const name = t.slice(t.lastIndexOf('/') + 1)
  return re.test(t) || re.test(name)
}

/** `*` → any run (path separators included), `?` → one character. */
function patternFor(query: string): RegExp {
  const body = query
    .split('')
    .map((c) => {
      if (c === '*') return '.*'
      if (c === '?') return '.'
      return c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${body}$`)
}
