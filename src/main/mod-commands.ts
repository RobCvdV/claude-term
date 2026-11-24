import { relative } from 'path'
import type { CreateDocResult, NpmScript, TabId } from '../shared/types'
import { npmRunLine, scriptKey } from '../shared/npm-script'

/**
 * The prompt box's app commands (/color, /add-file, /switch, /npm,
 * /remove-dir) for a tab typing straight into Claude Code: the term-bridge mod
 * registers them as slash commands and asks here to run or complete one.
 */

/** What the mod does with a run: print `text` and leave `context` for the model. */
export interface ModCommandResult {
  text: string
  context?: string
}

export interface ModSuggestion {
  /** what taking it writes over the word being typed */
  text: string
  label?: string
  description?: string
}

export interface ModCommandDeps {
  /** the tab's folder, for showing paths short */
  cwd(tabId: TabId): string | null
  /** type into Claude Code's input once the command is done (a leading `!` is shell mode) */
  type(tabId: TabId, text: string): void
  setColor(tabId: TabId, color: string): void
  createFile(tabId: TabId, path: string): Promise<CreateDocResult | null>
  openInEditor(tabId: TabId, path: string): void
  switchBranch(
    tabId: TabId,
    arg: string
  ): Promise<{ ok: boolean; error?: string; branch?: string; repo?: string }>
  removeDir(tabId: TabId, arg: string): { ok: true; dir: string } | { ok: false; error: string }
  npmScripts(tabId: TabId, query: string): Promise<NpmScript[]>
  branches(tabId: TabId, query: string): Promise<{ key: string; root?: string; repo?: string }[]>
  dirs(tabId: TabId, query: string): Promise<string[]>
  extraDirs(tabId: TabId): { name: string; path: string }[]
}

export const MOD_COMMANDS = [
  {
    name: 'color',
    description: 'Tint this tab (a color name, #rrggbb, or "off")',
    hint: '<color>'
  },
  {
    name: 'add-file',
    description: 'Create a file and open it in the file window',
    hint: '<folder/name>'
  },
  {
    name: 'switch',
    description: 'Switch git branch, here or in an added repo (repo:branch)',
    hint: '<[repo:]branch>'
  },
  {
    name: 'npm',
    description: 'Run an npm script (one folder deep, added folders as repo:script)',
    hint: '<[repo:]script>'
  },
  { name: 'remove-dir', description: 'Take an added folder back out of this tab', hint: '<folder>' }
] as const

const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'off']

export async function runModCommand(
  deps: ModCommandDeps,
  tabId: TabId,
  name: string,
  args: string
): Promise<ModCommandResult> {
  const arg = args.trim()
  switch (name) {
    case 'color': {
      if (!/^\S+$/.test(arg)) return { text: 'Usage: /color <name|#rrggbb|off>' }
      deps.setColor(tabId, arg.toLowerCase())
      return { text: `Tab color: ${arg.toLowerCase()}` }
    }
    case 'add-file': {
      if (!arg) return { text: 'Usage: /add-file <folder/name>' }
      const res = await deps.createFile(tabId, arg)
      if (!res) return { text: 'Not created.' }
      if (!res.ok) return { text: res.error }
      deps.openInEditor(tabId, res.path)
      const cwd = deps.cwd(tabId)
      return { text: `Created ${cwd ? relative(cwd, res.path) : res.path}` }
    }
    case 'switch': {
      if (!arg) return { text: 'Usage: /switch <[repo:]branch>' }
      const res = await deps.switchBranch(tabId, arg)
      if (!res.ok) return { text: res.error || 'git switch failed' }
      const branch = res.branch ?? arg
      const where = res.repo ? `the added repo \`${res.repo}\`` : 'this repo'
      return {
        text: `Switched ${res.repo ? `${res.repo} ` : ''}to ${branch}`,
        context: `I switched ${where} to branch \`${branch}\`. Files you read earlier may have changed — re-read before editing.`
      }
    }
    case 'npm': {
      if (!arg) return { text: 'Usage: /npm <[repo:]script> [params]' }
      const [head, ...params] = arg.split(/\s+/)
      const hit = (await deps.npmScripts(tabId, head)).find((s) => scriptKey(s) === head)
      const base = hit ? npmRunLine(hit).trimEnd() : `!npm run ${head}`
      deps.type(tabId, [base, ...params].join(' ') + ' ')
      return { text: '' }
    }
    case 'remove-dir': {
      if (!arg) return { text: 'Usage: /remove-dir <folder>' }
      const res = deps.removeDir(tabId, arg)
      return { text: res.ok ? `Removed ${res.dir} from this tab` : res.error }
    }
    default:
      return { text: `Unknown command /${name}` }
  }
}

export async function completeModCommand(
  deps: ModCommandDeps,
  tabId: TabId,
  name: string,
  query: string
): Promise<ModSuggestion[]> {
  const q = query.toLowerCase()
  switch (name) {
    case 'color':
      return COLORS.filter((c) => c.startsWith(q)).map((text) => ({ text }))
    case 'add-file': {
      const local = (await deps.dirs(tabId, query)).map((d) => ({ text: d }))
      if (query.includes('/')) return local
      const roots = deps
        .extraDirs(tabId)
        .filter((f) => f.name.toLowerCase().includes(q))
        .map((f) => ({ text: `${f.path}/`, label: `${f.name}/`, description: f.path }))
      return [...local, ...roots]
    }
    case 'switch':
      return (await deps.branches(tabId, query)).map((b) => ({
        text: b.key,
        ...(b.repo ? { description: b.root } : {})
      }))
    case 'npm':
      return (await deps.npmScripts(tabId, query)).map((s) => ({
        text: scriptKey(s),
        description: s.command
      }))
    case 'remove-dir':
      return deps
        .extraDirs(tabId)
        .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        .map((f) => ({ text: f.path, label: f.name, description: f.path }))
    default:
      return []
  }
}
