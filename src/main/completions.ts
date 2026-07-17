import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'

import type { SlashCommand } from '../shared/types'

const CACHE_TTL_MS = 30_000
const FILE_CACHE_TTL_MS = 15_000
const MAX_FILES = 20_000

/** Best-effort list of Claude Code built-ins (no API exists to query them). */
const BUILTINS: Array<[string, string, string?]> = [
  ['add-dir', 'Add an additional working directory to the session'],
  ['agents', 'Manage agent configurations'],
  ['bashes', 'List and manage background bash shells'],
  ['bug', 'Report a bug to Anthropic'],
  ['clear', 'Clear conversation history'],
  ['compact', 'Compact the conversation, keeping a summary', '[instructions]'],
  ['config', 'Open the settings panel'],
  ['context', 'Show current context usage breakdown'],
  ['cost', 'Show token/cost usage for this session'],
  ['doctor', 'Check the health of the Claude Code installation'],
  ['effort', 'Set reasoning effort level'],
  ['exit', 'Exit Claude Code'],
  ['export', 'Export the conversation'],
  ['fork', 'Copy the conversation into a new background session'],
  ['help', 'Show help and available commands'],
  ['hooks', 'Manage hook configurations'],
  ['ide', 'Manage IDE integration'],
  ['init', 'Create a CLAUDE.md file for this project'],
  ['install-github-app', 'Set up the Claude GitHub App'],
  ['login', 'Sign in to your Anthropic account'],
  ['logout', 'Sign out'],
  ['mcp', 'Manage MCP server connections'],
  ['memory', 'Edit memory files'],
  ['model', 'Change the model for this session'],
  ['output-style', 'Change the output style'],
  ['permissions', 'View or update tool permissions'],
  ['plugins', 'Manage plugins and marketplaces'],
  ['pr-comments', 'Get comments from a GitHub pull request'],
  ['release-notes', 'Show release notes'],
  ['rename', 'Rename the current session'],
  ['resume', 'Resume a previous session'],
  ['review', 'Review a pull request'],
  ['rewind', 'Rewind the conversation to an earlier point'],
  ['security-review', 'Security review of pending changes'],
  ['skills', 'List available skills'],
  ['status', 'Show session status (account, model, connectivity)'],
  ['statusline', 'Configure the status line'],
  ['terminal-setup', 'Configure terminal keybindings (Shift+Enter)'],
  ['todos', 'List current todo items'],
  ['usage', 'Show plan usage limits'],
  ['vim', 'Toggle vim editing mode']
]

const cmdCache = new Map<string, { at: number; items: SlashCommand[] }>()

export function listCommands(cwd: string): SlashCommand[] {
  const cached = cmdCache.get(cwd)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items

  const home = homedir()
  const byName = new Map<string, SlashCommand>()
  const add = (cmd: SlashCommand): void => {
    if (!byName.has(cmd.name)) byName.set(cmd.name, cmd)
  }

  for (const [name, description, hint] of BUILTINS) {
    add({ name, description, hint: hint ?? '', source: 'built-in' })
  }
  scanCommandsDir(join(cwd, '.claude', 'commands'), 'project', '', add)
  scanSkillsDir(join(cwd, '.claude', 'skills'), 'project', '', add)
  scanCommandsDir(join(home, '.claude', 'commands'), 'user', '', add)
  scanSkillsDir(join(home, '.claude', 'skills'), 'user', '', add)
  scanPlugins(home, add)

  const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  cmdCache.set(cwd, { at: Date.now(), items })
  return items
}

function parseFrontmatter(file: string): { description: string; hint: string } {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 4000)
    const match = /^---\n([\s\S]*?)\n---/.exec(text)
    const fm = match?.[1] ?? ''
    const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? ''
    const hint = /^argument-hint:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? ''
    return { description: truncate(description), hint }
  } catch {
    return { description: '', hint: '' }
  }
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + '…' : s
}

function scanCommandsDir(
  dir: string,
  source: SlashCommand['source'],
  prefix: string,
  add: (c: SlashCommand) => void
): void {
  if (!existsSync(dir)) return
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanCommandsDir(join(dir, entry.name), source, `${prefix}${entry.name}:`, add)
      } else if (entry.name.endsWith('.md')) {
        const { description, hint } = parseFrontmatter(join(dir, entry.name))
        add({ name: prefix + basename(entry.name, '.md'), description, hint, source })
      }
    }
  } catch {
    /* unreadable dir — skip */
  }
}

function scanSkillsDir(
  dir: string,
  source: SlashCommand['source'],
  prefix: string,
  add: (c: SlashCommand) => void
): void {
  if (!existsSync(dir)) return
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const skillFile = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const { description, hint } = parseFrontmatter(skillFile)
      add({ name: prefix + entry.name, description, hint, source })
    }
  } catch {
    /* skip */
  }
}

function scanPlugins(home: string, add: (c: SlashCommand) => void): void {
  try {
    const manifest = JSON.parse(
      readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
    ) as { plugins?: Record<string, Array<{ installPath?: string }>> }
    const settings = JSON.parse(
      readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
    ) as { enabledPlugins?: Record<string, boolean> }
    const enabled = settings.enabledPlugins ?? {}
    for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
      if (!enabled[key]) continue
      const shortName = key.split('@')[0]
      const installPath = installs[installs.length - 1]?.installPath
      if (!installPath) continue
      scanCommandsDir(join(installPath, 'commands'), 'plugin', `${shortName}:`, add)
      scanSkillsDir(join(installPath, 'skills'), 'plugin', `${shortName}:`, add)
    }
  } catch {
    /* no plugins */
  }
}

// ---- @file completions ----

const fileCache = new Map<string, { at: number; files: string[] }>()

async function listFiles(cwd: string): Promise<string[]> {
  const cached = fileCache.get(cwd)
  if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) return cached.files

  let files = await gitListFiles(cwd)
  if (files === null) files = walkFiles(cwd)
  if (files.length > MAX_FILES) files = files.slice(0, MAX_FILES)
  fileCache.set(cwd, { at: Date.now(), files })
  return files
}

function gitListFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { timeout: 5_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout.split('\n').filter(Boolean))
    )
  })
}

const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.cache', 'DerivedData'])

function walkFiles(root: string): string[] {
  const results: string[] = []
  const stack = ['']
  while (stack.length > 0 && results.length < MAX_FILES) {
    const rel = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(relPath)
      } else {
        results.push(relPath)
      }
    }
  }
  return results
}

/**
 * Queries containing ".." switch to shell-tab-style navigation: list ONE
 * directory level (no recursion, so climbing parents can never explode).
 * Directories come back with a trailing "/" — the renderer re-triggers the
 * suggest popup on accept so the user descends level by level.
 */
function navigateDir(cwd: string, query: string, limit: number): string[] {
  const lastSlash = query.lastIndexOf('/')
  const lastSeg = query.slice(lastSlash + 1)
  let dirPart: string
  let filter: string
  if (lastSeg === '..' || lastSeg === '.') {
    dirPart = query + '/'
    filter = ''
  } else {
    dirPart = query.slice(0, lastSlash + 1)
    filter = lastSeg
  }
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(resolve(cwd, dirPart), { withFileTypes: true })
  } catch {
    return []
  }
  const q = filter.toLowerCase()
  const scored: Array<{ name: string; isDir: boolean; score: number }> = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !filter.startsWith('.')) continue
    const lower = entry.name.toLowerCase()
    const score = !q ? 0 : lower.startsWith(q) ? 0 : lower.includes(q) ? 1 : -1
    if (score >= 0) scored.push({ name: entry.name, isDir: entry.isDirectory(), score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
  )
  return scored.slice(0, limit).map((e) => dirPart + e.name + (e.isDir ? '/' : ''))
}

export async function searchFiles(cwd: string, query: string, limit = 30): Promise<string[]> {
  if (/^\.\.(\/|$)/.test(query)) return navigateDir(cwd, query, limit)
  const files = await listFiles(cwd)
  const q = query.toLowerCase()
  if (!q) return files.slice(0, limit)

  const scored: Array<{ path: string; score: number }> = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const base = basename(lower)
    let score = -1
    if (base.startsWith(q)) score = 0
    else if (base.includes(q)) score = 1
    else if (lower.includes(q)) score = 2
    else if (isSubsequence(q, lower)) score = 3
    if (score >= 0) scored.push({ path, score })
    if (scored.length > 2000) break
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length)
  return scored.slice(0, limit).map((s) => s.path)
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}
