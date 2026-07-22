import { shell } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve, sep } from 'path'
import type { DocEntry, ProjectDocs } from '../shared/types'

const PLANS_DIR = join(homedir(), '.claude', 'plans')

/** Claude turns a project's cwd into its ~/.claude/projects folder name by
 *  replacing every "/" and "." with "-" (e.g. /Users/rob/x.y → -Users-rob-x-y). */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/** The file's first markdown H1, else its file name (sans extension). */
function titleFor(path: string): string {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 4096)
    for (const line of head.split('\n')) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (m) return m[1]
    }
  } catch {
    // unreadable — fall through to the file name
  }
  return basename(path).replace(/\.md$/i, '')
}

function entry(path: string): DocEntry {
  let mtime = 0
  try {
    mtime = statSync(path).mtimeMs
  } catch {
    // ignore — a 0 mtime just sorts last
  }
  return { path, title: titleFor(path), mtime }
}

// Scanning a project's transcripts means reading its (sometimes large) *.jsonl
// files. Cache per transcript keyed by mtime, so a re-scan only re-reads the
// files that changed (typically just the active session's) rather than every
// transcript in the project. Map<cwd, Map<filename, {mtime, paths}>>.
const planFileCache = new Map<string, Map<string, { mtime: number; paths: string[] }>>()

/** A transcript record carrying a plan-mode-exit attachment. */
interface PlanRecord {
  attachment?: { planFilePath?: unknown }
}

/** All structured plan paths recorded in one transcript's text. */
function extractPlanPaths(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    // cheap gate before the (relatively costly) JSON parse
    if (!line.includes('planFilePath')) continue
    let rec: PlanRecord
    try {
      rec = JSON.parse(line) as PlanRecord
    } catch {
      continue
    }
    const p = rec.attachment?.planFilePath
    if (typeof p === 'string') out.push(p)
  }
  return out
}

/** Plan-mode plans (in ~/.claude/plans) that this project's Claude sessions
 *  created. Each JSONL record in ~/.claude/projects/<encoded-cwd>/ that ends a
 *  plan mode carries the plan path at the structured `attachment.planFilePath`
 *  field; we parse the records and read only that field — never a substring of
 *  the raw text, since tool output (e.g. `ls ~/.claude/plans`) can otherwise
 *  drag in every plan. Filtered to files that still exist, newest-first. */
function plansForProject(cwd: string): DocEntry[] {
  const projDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd))
  if (!existsSync(projDir)) return []

  let files: string[]
  try {
    files = readdirSync(projDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  let cache = planFileCache.get(cwd)
  if (!cache) {
    cache = new Map()
    planFileCache.set(cwd, cache)
  }

  const paths = new Set<string>()
  const live = new Set<string>()
  for (const f of files) {
    live.add(f)
    const full = join(projDir, f)
    let mtime = 0
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      continue
    }
    let hit = cache.get(f)
    if (!hit || hit.mtime !== mtime) {
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      hit = { mtime, paths: extractPlanPaths(text) }
      cache.set(f, hit)
    }
    for (const p of hit.paths) paths.add(p)
  }
  // forget transcripts that were removed
  for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key)

  const plansRoot = resolve(PLANS_DIR)
  const plans: DocEntry[] = []
  for (const p of paths) {
    // stay inside the plans dir and confirm the file still exists
    if (resolve(p).startsWith(plansRoot + sep) && existsSync(p)) plans.push(entry(p))
  }
  plans.sort((a, b) => b.mtime - a.mtime)
  return plans
}

/** Every *.md under `dir`, recursively (skips dot-files/dirs). */
function listMarkdown(dir: string): string[] {
  const out: string[] = []
  let items: import('fs').Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const it of items) {
    if (it.name.startsWith('.')) continue
    const full = join(dir, it.name)
    if (it.isDirectory()) out.push(...listMarkdown(full))
    else if (it.isFile() && /\.md$/i.test(it.name)) out.push(full)
  }
  return out
}

/** Roadmap + docs that live inside the project folder. */
function repoDocs(cwd: string): { roadmap: DocEntry | null; docs: DocEntry[] } {
  let rootMd: string[] = []
  try {
    rootMd = readdirSync(cwd).filter((f) => /\.md$/i.test(f))
  } catch {
    return { roadmap: null, docs: [] }
  }

  // roadmap = ROADMAP.md exactly, else the first roadmap*.md (case-insensitive)
  const roadmapName =
    rootMd.find((f) => f.toLowerCase() === 'roadmap.md') ??
    rootMd.find((f) => /^roadmap.*\.md$/i.test(f)) ??
    null
  const roadmap = roadmapName ? entry(join(cwd, roadmapName)) : null

  // root docs: every other root *.md, README pinned first, then alphabetical
  const rootDocs = rootMd
    .filter((f) => f !== roadmapName)
    .map((f) => join(cwd, f))
    .sort((a, b) => {
      const ar = /readme\.md$/i.test(a) ? 0 : 1
      const br = /readme\.md$/i.test(b) ? 0 : 1
      return ar - br || basename(a).localeCompare(basename(b))
    })

  // then everything under docs/, by path
  const docsDir = join(cwd, 'docs')
  const subDocs = existsSync(docsDir)
    ? listMarkdown(docsDir).sort((a, b) => a.localeCompare(b))
    : []

  return { roadmap, docs: [...rootDocs, ...subDocs].map(entry) }
}

export function listProjectDocs(cwd: string): ProjectDocs {
  const { roadmap, docs } = repoDocs(cwd)
  return { plans: plansForProject(cwd), roadmap, docs }
}

/** The overlay may only read/open files inside the plans dir or the project cwd. */
function allowed(cwd: string, path: string): boolean {
  const p = resolve(path)
  return [resolve(PLANS_DIR), resolve(cwd)].some((r) => p === r || p.startsWith(r + sep))
}

export function readDoc(cwd: string, path: string): string | null {
  if (!allowed(cwd, path) || !existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Open the file in the OS default markdown app for editing. */
export async function openDoc(cwd: string, path: string): Promise<boolean> {
  if (!allowed(cwd, path) || !existsSync(path)) return false
  const err = await shell.openPath(path)
  return err === ''
}
