import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import type { NpmScript } from '../shared/types'
import { scriptKey } from '../shared/npm-script'
import type { FolderChip } from '../shared/status-folders'
import { rankByQuery } from './completions'

const CACHE_TTL_MS = 10_000
const cache = new Map<string, { at: number; scripts: NpmScript[] }>()

function readScripts(dir: string, sub: string): NpmScript[] {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    return Object.entries(json.scripts ?? {}).map(([name, command]) => ({
      dir: sub,
      name,
      command: String(command)
    }))
  } catch {
    return []
  }
}

/** Root package.json scripts first, then each one-level-deep subfolder's. */
function collect(cwd: string): NpmScript[] {
  const out = readScripts(cwd, '')
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
      continue
    out.push(...readScripts(join(cwd, entry.name), entry.name))
  }
  return out
}

/** Scripts for the `/npm` picker: the tab's folder first, then each added
 *  folder's (keyed `repo:…`), ranked like /switch. */
export function listNpmScripts(
  cwd: string,
  query: string,
  limit = 30,
  extras: readonly FolderChip[] = []
): NpmScript[] {
  const all = [
    ...scriptsOf(cwd),
    ...extras.flatMap((f) => scriptsOf(f.path).map((s) => ({ ...s, repo: f.name, root: f.path })))
  ]
  return rankByQuery(all, scriptKey, query, limit)
}

function scriptsOf(dir: string): NpmScript[] {
  const cached = cache.get(dir)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.scripts
  const scripts = collect(dir)
  cache.set(dir, { at: Date.now(), scripts })
  return scripts
}
