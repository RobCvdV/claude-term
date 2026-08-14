import { shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { MAX_EDIT_BYTES } from '../shared/types'
import type { CreateDocResult, DocEntry, DocSection, ProjectDocs } from '../shared/types'
import { expandHome } from './completions'
import { insideAny, SKIP_DIRS, treeRoots } from './file-tree'

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
  let size = 0
  try {
    const stat = statSync(path)
    mtime = stat.mtimeMs
    size = stat.size
  } catch {
    // ignore — a 0 mtime just sorts last
  }
  return { path, title: titleFor(path), mtime, size }
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

/** The markdown groups and tree roots of a project. The file window's payload
 *  adds the configuration files to this (see the `docs:list` handler). */
export function listProjectDocs(
  cwd: string,
  addedDirs: string[] = []
): Omit<ProjectDocs, 'config' | 'patternsFile'> {
  const { roadmap, sections } = repoDocs(cwd)
  return {
    plans: plansForProject(cwd),
    roadmap,
    sections,
    roots: treeRoots(cwd, addedDirs)
  }
}

/** The window may only reach files inside the plans dir or one of its roots
 *  (the tab's cwd and its added directories). */
function allowed(roots: string[], path: string): boolean {
  return insideAny([PLANS_DIR, ...roots], path)
}

/** A file's text, or null when it is out of reach, missing or unreadable. Over
 *  MAX_EDIT_BYTES it reads only when the window asks for it explicitly — the
 *  user answering "Open anyway" to the size warning. */
export function readDoc(roots: string[], path: string, allowOversize = false): string | null {
  if (!allowed(roots, path) || !existsSync(path)) return null
  try {
    if (!allowOversize && statSync(path).size > MAX_EDIT_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Open the file in the OS default app for editing. */
export async function openDoc(roots: string[], path: string): Promise<boolean> {
  if (!allowed(roots, path) || !existsSync(path)) return false
  const err = await shell.openPath(path)
  return err === ''
}

/** Reveal the file in Finder / Explorer (the folder opens with it selected). */
export function revealDoc(roots: string[], path: string): boolean {
  if (!allowed(roots, path) || !existsSync(path)) return false
  shell.showItemInFolder(path)
  return true
}

/** Overwrite an existing doc from the in-app editor. Only existing files inside
 *  the plans dir or the project cwd may be written — never create new paths. */
export function writeDoc(roots: string[], path: string, content: string): boolean {
  if (!allowed(roots, path) || !existsSync(path)) return false
  try {
    writeFileSync(path, content, 'utf8')
    return true
  } catch {
    return false
  }
}

/** The file a `/add-file` argument names, taken literally — any extension or
 *  none (`.gitignore`, `Makefile`, `notes`). Null when it names no file. */
export function newFileName(arg: string): string | null {
  const path = arg.trim()
  if (!path || path.endsWith('/')) return null
  const name = basename(path)
  return !name || name === '.' || name === '..' ? null : path
}

const MARKDOWN = /\.(md|markdown|mdx)$/i

/** Seed heading for a new markdown file, from its name: `plan-of-attack.md` →
 *  "Plan of attack". Gives the file a real title in the docs rail from the
 *  start; anything else is created empty, since a heading would be noise. */
function seedContent(path: string): string {
  if (!MARKDOWN.test(path)) return ''
  const words = basename(path).replace(MARKDOWN, '').replace(/[-_]+/g, ' ').trim()
  return `# ${words.charAt(0).toUpperCase() + words.slice(1)}\n\n`
}

/** The name the "New file" picker opens on — markdown, since that is what
 *  nearly every file made from the app turns out to be. */
const SUGGESTED_NAME = 'untitled.md'

/**
 * Where the "New file" save dialog should start: next to the file the window
 * currently has open, so a new doc lands beside its neighbours. Falls back to
 * the project root whenever `near` is missing or outside the project — the
 * picker must never suggest a folder the window could not then open.
 */
export function newFileStartPath(cwd: string, addedDirs: string[] = [], near?: string): string {
  const dir = near && insideAny([cwd, ...addedDirs], near) ? near : cwd
  return join(dir, SUGGESTED_NAME)
}

/** What creating one new file would do: where it lands, and which folders have
 *  to be made for it — the folders are what the caller confirms first. */
export interface NewFilePlan {
  path: string
  /** folders that do not exist yet, outermost first, relative to `cwd` where
   *  they sit under it (`docs/plans`), absolute where they don't */
  missingDirs: string[]
}

/**
 * Resolve and vet a new file's path without touching the disk. Splitting this
 * out of createDoc is what lets a caller ask before creating folders: the same
 * checks run, and nothing has happened yet when it says what is missing.
 */
export function planNewFile(
  cwd: string,
  arg: string,
  addedDirs: string[] = []
): { ok: true; plan: NewFilePlan } | { ok: false; error: string } {
  const name = newFileName(arg)
  if (!name) return { ok: false, error: 'Give a file name, e.g. docs/plan.md' }
  const path = resolve(cwd, expandHome(name) ?? name)
  if (!allowed([cwd, ...addedDirs], path)) return { ok: false, error: 'Outside this project' }
  if (existsSync(path)) return { ok: false, error: `Already exists: ${basename(path)}` }
  return { ok: true, plan: { path, missingDirs: missingDirsFor(cwd, path) } }
}

/** The folders that would have to be created for `path`, outermost first. */
function missingDirsFor(cwd: string, path: string): string[] {
  const missing: string[] = []
  for (let dir = dirname(path); !existsSync(dir); dir = dirname(dir)) {
    missing.unshift(insideAny([cwd], dir) ? relative(cwd, dir) : dir)
    if (dirname(dir) === dir) break // reached the filesystem root
  }
  return missing
}

/** Create the file `/add-file` asked for and return its absolute path. Same
 *  roots as the rest of the overlay (plans dir or project cwd); missing parent
 *  folders are created, existing files are never touched. */
export function createDoc(cwd: string, arg: string, addedDirs: string[] = []): CreateDocResult {
  const planned = planNewFile(cwd, arg, addedDirs)
  if (!planned.ok) return planned
  const { path } = planned.plan
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, seedContent(path), 'utf8')
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not create the file' }
  }
  return { ok: true, path }
}
