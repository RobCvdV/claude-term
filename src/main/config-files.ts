import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import type { ConfigEntry, ConfigSection, ProjectConfigFiles } from '../shared/types'
import { matchesAny } from './config-patterns'

/**
 * The configuration/settings files of a project, for the status-bar Settings
 * window. Deliberately broad so it covers the stacks in play (node/web, React
 * Native + Cordova mobile, Delphi, CI) — and tunable, because "what counts as
 * config" varies per project and shouldn't need a code change.
 */

/** File names/globs treated as configuration. Matched on the base name unless
 *  the pattern contains a "/" (see config-patterns.ts). */
export const DEFAULT_INCLUDE: readonly string[] = [
  // structured formats
  '*.{json,jsonc,json5}',
  '*.{yml,yaml}',
  '*.{xml,plist}',
  '*.{toml,ini,cfg,conf,properties}',
  // scripts that are configuration in practice
  '*.{js,cjs,mjs,ts,tsx,mts,cts}',
  // Delphi projects
  '*.{dproj,groupproj,dpk,dpr,dof,inc}',
  // JVM / mobile build files
  '*.gradle',
  'Podfile',
  'Gemfile',
  'Brewfile',
  'Dockerfile',
  'Makefile',
  // env files
  '.env',
  '.env.*',
  // conventional dotfiles
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.dockerignore',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.prettierignore',
  '.eslintignore',
  '.tool-versions',
  '.ruby-version',
  '.python-version',
  // .prettierrc, .babelrc, .eslintrc(.json|.yml|…)
  '.*rc',
  '.*rc.{json,js,cjs,mjs,yml,yaml,toml}',
  // catch-alls the user asked for explicitly
  '*config*',
  '*properties*'
]

/** Matches the includes but is generated noise, not something you'd hand-edit.
 *  (`package-lock.json` is the big one — it is a *.json in every node project.) */
export const DEFAULT_EXCLUDE: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Podfile.lock',
  'Gemfile.lock',
  '*.tsbuildinfo',
  '*.min.js',
  '*.map',
  '*.d.ts'
]

/** Markdown only counts inside dot-folders (.claude/agents/*.md and friends) —
 *  project markdown is already the Docs window's job. */
const DOT_DIR_INCLUDE: readonly string[] = ['*.md']

/** Directories never worth walking: dependencies, build output, IDE caches. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.cache',
  '.turbo',
  '.next',
  '.venv',
  '__pycache__',
  'DerivedData',
  'Pods',
  'vendor',
  'target',
  '.gradle',
  '.dart_tool',
  // Delphi build/backup droppings
  '__history',
  '__recovery'
])

/** Sub-folders (relative to a root) scanned recursively rather than one level. */
const DEEP_DIRS = ['test', 'test-api', 'tests']

const MAX_DEPTH = 6
const MAX_FILES_PER_ROOT = 2000

export interface ConfigPatterns {
  include: string[]
  exclude: string[]
}

const EMPTY_PATTERNS: ConfigPatterns = { include: [], exclude: [] }

/** The user's extra patterns, layered over the defaults. Missing/invalid file
 *  simply means "defaults only" — this must never break the listing. */
export function readPatterns(patternsFile: string): ConfigPatterns {
  try {
    const raw = JSON.parse(readFileSync(patternsFile, 'utf8')) as Partial<ConfigPatterns>
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return { include: strings(raw.include), exclude: strings(raw.exclude) }
  } catch {
    return EMPTY_PATTERNS
  }
}

const PATTERNS_TEMPLATE = `{
  "//": "Extra patterns for the Settings window, layered over its defaults.",
  "//include": "Files to also list, e.g. \\"*.sh\\" or \\"config/**\\".",
  "//exclude": "Files to hide, e.g. \\"*.tsbuildinfo\\". Exclude wins over include.",
  "include": [],
  "exclude": []
}
`

/** Create the patterns file on first use — `writeConfigFile` only overwrites
 *  files that already exist, so it has to be on disk to be editable. */
export function ensurePatternsFile(patternsFile: string): void {
  if (existsSync(patternsFile)) return
  try {
    writeFileSync(patternsFile, PATTERNS_TEMPLATE, 'utf8')
  } catch {
    /* best effort — without it the user just can't tune the patterns */
  }
}

function isConfigFile(rel: string, patterns: ConfigPatterns, inDotDir: boolean): boolean {
  if (matchesAny(rel, DEFAULT_EXCLUDE) || matchesAny(rel, patterns.exclude)) return false
  if (matchesAny(rel, DEFAULT_INCLUDE) || matchesAny(rel, patterns.include)) return true
  return inDotDir && matchesAny(rel, DOT_DIR_INCLUDE)
}

function entryFor(root: string, path: string): ConfigEntry {
  let mtime = 0
  let size = 0
  try {
    const st = statSync(path)
    mtime = st.mtimeMs
    size = st.size
  } catch {
    // unreadable — a 0 mtime/size still lists, and reading will fail cleanly
  }
  return { path, rel: relative(root, path).split(sep).join('/'), mtime, size }
}

/** Recursive walk collecting config files, depth- and count-capped. */
function walk(
  root: string,
  dir: string,
  patterns: ConfigPatterns,
  inDotDir: boolean,
  depth: number,
  out: string[]
): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_ROOT) return
  let items: import('fs').Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const it of items) {
    if (out.length >= MAX_FILES_PER_ROOT) return
    const full = join(dir, it.name)
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue
      walk(root, full, patterns, inDotDir || it.name.startsWith('.'), depth + 1, out)
    } else if (it.isFile()) {
      const rel = relative(root, full).split(sep).join('/')
      if (isConfigFile(rel, patterns, inDotDir)) out.push(full)
    }
  }
}

/** Config files for one root: its own files (not recursive), plus test folders
 *  and dot-folders walked in full. Keeps the top level shallow so a monorepo
 *  doesn't bury the root's own config under every package's. */
function scanRoot(root: string, patterns: ConfigPatterns): string[] {
  const found: string[] = []
  let items: import('fs').Dirent[]
  try {
    items = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }

  for (const it of items) {
    if (!it.isFile()) continue
    if (isConfigFile(it.name, patterns, false)) found.push(join(root, it.name))
  }

  for (const it of items) {
    if (!it.isDirectory() || SKIP_DIRS.has(it.name)) continue
    const deep = it.name.startsWith('.') || DEEP_DIRS.includes(it.name)
    if (deep) walk(root, join(root, it.name), patterns, it.name.startsWith('.'), 1, found)
  }
  return found
}

/** Root files first, then by path — so a root's own config leads its section. */
function byRel(a: ConfigEntry, b: ConfigEntry): number {
  const ad = a.rel.includes('/') ? 1 : 0
  const bd = b.rel.includes('/') ? 1 : 0
  return ad - bd || a.rel.localeCompare(b.rel)
}

/** Absolute, existing, de-duplicated roots: the tab's cwd first, then each
 *  added directory that isn't already covered by one of the earlier roots. */
export function resolveRoots(cwd: string, addedDirs: readonly string[]): string[] {
  const roots: string[] = []
  for (const dir of [cwd, ...addedDirs]) {
    if (!dir) continue
    const abs = resolve(dir)
    if (!existsSync(abs)) continue
    try {
      if (!statSync(abs).isDirectory()) continue
    } catch {
      continue
    }
    // an added dir inside an existing root would list the same files twice
    if (roots.some((r) => abs === r || abs.startsWith(r + sep))) continue
    roots.push(abs)
  }
  return roots
}

export function listConfigFiles(
  cwd: string,
  addedDirs: readonly string[],
  patternsFile: string
): ProjectConfigFiles {
  ensurePatternsFile(patternsFile)
  const patterns = readPatterns(patternsFile)
  const roots = resolveRoots(cwd, addedDirs)

  const sections: ConfigSection[] = []
  for (const root of roots) {
    const entries = scanRoot(root, patterns).map((p) => entryFor(root, p))
    if (!entries.length) continue
    entries.sort(byRel)
    sections.push({
      name: basename(root) || root,
      root,
      // added roots live elsewhere on disk; show where
      subtitle: root === roots[0] ? undefined : root,
      entries
    })
  }

  // the app's own patterns file, so it can be tuned from the same editor
  if (existsSync(patternsFile)) {
    const dir = dirname(patternsFile)
    sections.push({
      name: 'claude-term',
      root: dir,
      subtitle: 'Settings-window patterns',
      entries: [entryFor(dir, patternsFile)]
    })
  }

  return { sections, patternsFile }
}
