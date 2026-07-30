/**
 * The glob subset used to decide which files count as project configuration.
 * There is no glob dependency in this project (and pulling one in for a handful
 * of patterns isn't worth it), so this implements just what the include/exclude
 * lists need: `*`, `**`, `?` and `{a,b}` alternation.
 *
 * A pattern without a `/` matches the file's *base name* at any depth
 * (gitignore-style, so `*.json` finds `.claude/settings.json`); a pattern that
 * contains a `/` matches the whole path relative to its scan root.
 */

/** Brace alternation is expanded up front so the regex builder stays flat —
 *  and so alternatives may themselves contain globs (`{*.yml,*.yaml}`). */
export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern)
  if (!m) return [pattern]
  const head = pattern.slice(0, m.index)
  const tail = pattern.slice(m.index + m[0].length)
  return m[1].split(',').flatMap((alt) => expandBraces(head + alt + tail))
}

function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/** Compile one brace-free glob. `*` and `?` stop at `/`; `**` crosses it. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        // "**/x" must also match a bare "x" — make the separator part optional
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*\\/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += escapeLiteral(ch)
    }
  }
  // case-insensitive: config names are conventional, not guaranteed (.YML, Makefile)
  return new RegExp(`^${re}$`, 'i')
}

// Patterns are re-tested against thousands of paths per scan; compile once.
const cache = new Map<string, RegExp[]>()

function regexesFor(pattern: string): RegExp[] {
  let hit = cache.get(pattern)
  if (!hit) {
    hit = expandBraces(pattern).map(globToRegExp)
    cache.set(pattern, hit)
  }
  return hit
}

/**
 * Does `relPath` (posix, relative to its scan root) match `pattern`?
 * Base-name matching for patterns without a separator — see the module comment.
 */
export function matchesPattern(relPath: string, pattern: string): boolean {
  const subject = pattern.includes('/') ? relPath : (relPath.split('/').pop() ?? relPath)
  return regexesFor(pattern).some((re) => re.test(subject))
}

export function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(relPath, p))
}
