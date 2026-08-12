import { shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'
import type { CreateDocResult, DocEntry, DocSection, ProjectDocs } from '../shared/types'
import { expandHome } from './completions'

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

/** Sub-directories never worth scanning for docs (heavy or build output). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage'])

/** README first, then alphabetical by file name — the order docs are shown in. */
function byDocName(a: string, b: string): number {
  const ar = /readme\.md$/i.test(a) ? 0 : 1
  const br = /readme\.md$/i.test(b) ? 0 : 1
  return ar - br || basename(a).localeCompare(basename(b))
}

/** The *.md files directly inside `dir` (not recursive). */
function markdownIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((it) => it.isFile() && /\.md$/i.test(it.name))
      .map((it) => join(dir, it.name))
  } catch {
    return []
  }
}

/** Roadmap + doc sections that live inside the project folder. Scans the root
 *  and every immediate sub-folder (one level deep), grouping each folder's *.md
 *  into its own section — so ad-hoc folders like research/ or tmp/ show up too. */
function repoDocs(cwd: string): { roadmap: DocEntry | null; sections: DocSection[] } {
  let items: import('fs').Dirent[]
  try {
    items = readdirSync(cwd, { withFileTypes: true })
  } catch {
    return { roadmap: null, sections: [] }
  }

  const rootMd = items.filter((it) => it.isFile() && /\.md$/i.test(it.name)).map((it) => it.name)

  // roadmap = ROADMAP.md exactly, else the first roadmap*.md (case-insensitive)
  const roadmapName =
    rootMd.find((f) => f.toLowerCase() === 'roadmap.md') ??
    rootMd.find((f) => /^roadmap.*\.md$/i.test(f)) ??
    null

  const sections: DocSection[] = []

  // root section (the project folder's own *.md, minus the roadmap)
  const rootFiles = rootMd
    .filter((f) => f !== roadmapName)
    .map((f) => join(cwd, f))
    .sort(byDocName)
  if (rootFiles.length) sections.push({ name: basename(cwd) || cwd, entries: rootFiles.map(entry) })

  // one section per immediate sub-folder that holds *.md, folder-name sorted
  const subDirs = items
    .filter((it) => it.isDirectory() && !it.name.startsWith('.') && !SKIP_DIRS.has(it.name))
    .map((it) => it.name)
    .sort((a, b) => a.localeCompare(b))
  for (const name of subDirs) {
    const files = markdownIn(join(cwd, name)).sort(byDocName)
    if (files.length) sections.push({ name, entries: files.map(entry) })
  }

  const roadmap = roadmapName ? entry(join(cwd, roadmapName)) : null
  return { roadmap, sections }
}

export function listProjectDocs(cwd: string): ProjectDocs {
  const { roadmap, sections } = repoDocs(cwd)
  return { plans: plansForProject(cwd), roadmap, sections }
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

/** Overwrite an existing doc from the in-app editor. Only existing files inside
 *  the plans dir or the project cwd may be written — never create new paths. */
export function writeDoc(cwd: string, path: string, content: string): boolean {
  if (!allowed(cwd, path) || !existsSync(path)) return false
  try {
    writeFileSync(path, content, 'utf8')
    return true
  } catch {
    return false
  }
}

/** The markdown file a `/add-file` argument asks for: a bare name gains `.md`,
 *  any other extension is refused (so `notes.txt` never becomes `notes.txt.md`). */
export function normalizeDocName(arg: string): string | null {
  const path = arg.trim()
  if (!path || path.endsWith('/')) return null
  if (/\.md$/i.test(path)) return path
  return /\.[^./]+$/.test(basename(path)) ? null : path + '.md'
}

/** Seed heading for a new doc, from its file name: `plan-of-attack.md` → "Plan
 *  of attack". Gives the file a real title in the docs rail from the start. */
function docHeading(path: string): string {
  const words = basename(path).replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Create a new markdown doc for `/add-file` and return its absolute path.
 *  Same roots as the rest of the overlay (plans dir or project cwd); missing
 *  parent folders are created, existing files are never touched. */
export function createDoc(cwd: string, arg: string): CreateDocResult {
  const name = normalizeDocName(arg)
  if (!name) return { ok: false, error: 'Give a markdown file name, e.g. docs/plan.md' }
  const path = resolve(cwd, expandHome(name) ?? name)
  if (!allowed(cwd, path)) return { ok: false, error: 'Outside this project' }
  if (existsSync(path)) return { ok: false, error: `Already exists: ${basename(path)}` }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `# ${docHeading(path)}\n\n`, 'utf8')
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not create the file' }
  }
  return { ok: true, path }
}
