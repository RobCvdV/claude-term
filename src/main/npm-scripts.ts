import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import type { NpmScript } from '../shared/types'

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

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

export function scriptKey(s: NpmScript): string {
  return s.dir ? `${s.dir}/${s.name}` : s.name
}

/** Scripts for the `/npm` picker, substring/subsequence-matched like /switch. */
export function listNpmScripts(cwd: string, query: string, limit = 30): NpmScript[] {
  const cached = cache.get(cwd)
  const scripts = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.scripts : collect(cwd)
  if (!cached || scripts !== cached.scripts) cache.set(cwd, { at: Date.now(), scripts })

  const q = query.trim().toLowerCase()
  if (!q) return scripts.slice(0, limit)

  const scored: Array<{ s: NpmScript; score: number }> = []
  for (const s of scripts) {
    const key = scriptKey(s).toLowerCase()
    let score = -1
    if (key.startsWith(q)) score = 0
    else if (key.includes(q)) score = 1
    else if (isSubsequence(q, key)) score = 2
    if (score >= 0) scored.push({ s, score })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((e) => e.s)
}
