import type { NpmScript } from './types'

/** The `/npm` argument naming a script: `[repo:][dir/]name`. */
export function scriptKey(s: NpmScript): string {
  const local = s.dir ? `${s.dir}/${s.name}` : s.name
  return s.repo ? `${s.repo}:${local}` : local
}

/** The runnable `!npm …` line for a script (trailing space invites params). */
export function npmRunLine(s: NpmScript): string {
  const dir = [s.root, s.dir].filter(Boolean).join('/')
  const prefix = dir ? `--prefix ${quoteArg(dir)} ` : ''
  return `!npm ${prefix}run ${quoteArg(s.name)} `
}

function quoteArg(v: string): string {
  return /[^\w./:@-]/.test(v) ? JSON.stringify(v) : v
}
