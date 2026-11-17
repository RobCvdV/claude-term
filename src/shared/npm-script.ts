import type { NpmScript } from './types'

/** The `/npm` argument naming a script: `[repo:][dir/]name`. */
export function scriptKey(s: NpmScript): string {
  const local = s.dir ? `${s.dir}/${s.name}` : s.name
  return s.repo ? `${s.repo}:${local}` : local
}
