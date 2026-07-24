import type { SlashCommand, TabId } from '../../shared/types'

// App-local commands: intercepted in the prompt box and handled inside the app,
// never sent to claude. They ride the same Monaco suggest widget as claude's
// real commands, but their name list and argument completions come from here.

export interface AppCompletion {
  label: string
  value: string
  detail?: string
  /** a directory: insert without a trailing space and reopen the popup to descend */
  isDir?: boolean
}

export interface AppCommandCtx {
  tabId: TabId
  arg: string
  setColor: (color: string) => void
  setError: (msg: string) => void
}

export interface AppCommand {
  name: string
  description: string
  hint?: string
  /** Enter on an argument suggestion accepts it AND submits (runs) immediately. */
  runOnPick?: boolean
  /** reject a submitted arg so the command falls through to claude instead. */
  validate?: (arg: string) => boolean
  /** argument suggestions for the current query (drives the `/name <arg>` popup). */
  complete?: (tabId: TabId, query: string) => Promise<AppCompletion[]>
  /** run on submit; return false to KEEP the box text (e.g. on error), else clear. */
  run: (ctx: AppCommandCtx) => boolean | Promise<boolean>
}

export const APP_COMMANDS: AppCommand[] = [
  {
    name: 'color',
    description: 'Tint this tab (a color name, #rrggbb, or "off")',
    hint: '<color>',
    validate: (arg) => /^\S+$/.test(arg),
    run: ({ arg, setColor }) => {
      setColor(arg.toLowerCase())
      return true
    }
  },
  {
    name: 'switch',
    description: 'Switch git branch (filter by name or ticket number)',
    hint: '<branch>',
    runOnPick: true,
    validate: (arg) => arg.trim().length > 0,
    complete: async (tabId, query) => {
      const branches = await window.claudeTerm.listBranches(tabId, query)
      return branches.map((b) => ({ label: b, value: b }))
    },
    run: async ({ tabId, arg, setError }) => {
      const res = await window.claudeTerm.switchBranch(tabId, arg)
      if (!res.ok) {
        setError(res.error || 'git switch failed')
        return false
      }
      // notify only (no /clear): let claude know its file view may be stale
      window.claudeTerm.submitPrompt(
        tabId,
        `FYI: I switched this repo to branch \`${arg}\`. Files you read earlier may have changed — re-read before editing.`,
        0
      )
      return true
    }
  }
]

const byName = new Map(APP_COMMANDS.map((c) => [c.name, c]))

export function getAppCommand(name: string): AppCommand | undefined {
  return byName.get(name)
}

export type ArgCompleter = (tabId: TabId, query: string) => Promise<AppCompletion[]>

// claude's own commands we don't intercept but DO assist with a directory
// picker for their path argument; the full "/name <path>" still goes to claude.
const PATH_COMMANDS = new Set(['add-dir'])

const completeDir: ArgCompleter = async (tabId, query) => {
  const dirs = await window.claudeTerm.listDirs(tabId, query)
  return dirs.map((d) => ({ label: d, value: d, isDir: true }))
}

/**
 * Argument completer for `/name <arg>`, if any — an app command's own
 * `complete`, or the directory picker for a path command (/add-dir).
 * Independent of whether the command is intercepted.
 */
export function getArgCompleter(name: string): ArgCompleter | undefined {
  const cmd = getAppCommand(name)
  if (cmd?.complete) return cmd.complete
  if (PATH_COMMANDS.has(name)) return completeDir
  return undefined
}

/** Does Enter on this line's arg suggestion mean "pick + run immediately"? */
export function picksAndRuns(line: string): boolean {
  const m = /^\/(\S+)(?:\s|$)/.exec(line.trim())
  if (!m) return false
  // intercepted app commands (e.g. /switch) run on Enter; dir picks descend
  return !!getAppCommand(m[1])?.runOnPick
}

/** App commands mapped to the SlashCommand shape, for the `/` command menu. */
export function appSlashCommands(): SlashCommand[] {
  return APP_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    hint: c.hint ?? '',
    source: 'app'
  }))
}

/** Match a fully-typed message to an app command + its (validated) argument. */
export function matchAppCommand(text: string): { cmd: AppCommand; arg: string } | null {
  const line = text.split('\n')[0].trim()
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line)
  if (!m) return null
  const cmd = getAppCommand(m[1])
  if (!cmd) return null
  const arg = (m[2] ?? '').trim()
  if (cmd.validate && !cmd.validate(arg)) return null
  return { cmd, arg }
}
