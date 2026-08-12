import type { NpmScript, SlashCommand, TabId } from '../../shared/types'
import { getSpellConfig, setSpellConfig, type SpellConfig, type SpellLang } from './spell'

// App-local commands: intercepted in the prompt box and handled inside the app,
// never sent to claude. They ride the same Monaco suggest widget as claude's
// real commands, but their name list and argument completions come from here.

export interface AppCompletion {
  label: string
  value: string
  detail?: string
  /** a directory: insert without a trailing space and reopen the popup to descend */
  isDir?: boolean
  /** accept replaces the WHOLE line with this text (Tab fills it, Enter runs it) */
  lineText?: string
}

export interface AppCommandCtx {
  tabId: TabId
  arg: string
  setColor: (color: string) => void
  setError: (msg: string) => void
  /** open one doc in the docs window's markdown editor */
  editDoc: (path: string) => void
}

export type ArgCompleter = (tabId: TabId, query: string) => Promise<AppCompletion[]>

/** Single-level directory picker: accepting a folder descends into it. */
const completeDir: ArgCompleter = async (tabId, query) => {
  const dirs = await window.claudeTerm.listDirs(tabId, query)
  return dirs.map((d) => ({ label: d, value: d, isDir: true }))
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
    name: 'add-file',
    description: 'Create a markdown doc and open it in the docs editor',
    hint: '<folder/name.md>',
    complete: completeDir,
    run: async ({ tabId, arg, setError, editDoc }) => {
      const res = await window.claudeTerm.createDoc(tabId, arg)
      if (!res.ok) {
        setError(res.error)
        return false
      }
      editDoc(res.path)
      return true
    }
  },
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
  },
  {
    name: 'npm',
    description: 'Run an npm script (root package.json or one folder deep)',
    hint: '<script>',
    runOnPick: true,
    validate: (arg) => arg.trim().length > 0,
    complete: async (tabId, query) => {
      const scripts = await window.claudeTerm.listNpmScripts(tabId, query)
      return scripts.map((s) => {
        const key = s.dir ? `${s.dir}/${s.name}` : s.name
        return { label: key, value: key, detail: s.command, lineText: npmRunLine(s) }
      })
    },
    run: async ({ tabId, arg }) => {
      // hand-typed arg: first token may be a "dir/script" key; the rest is params
      const [head, ...params] = arg.trim().split(/\s+/)
      const scripts = await window.claudeTerm.listNpmScripts(tabId, head)
      const hit = scripts.find((s) => (s.dir ? `${s.dir}/${s.name}` : s.name) === head)
      const base = hit ? npmRunLine(hit).trimEnd() : `!npm run ${head}`
      window.claudeTerm.submitPrompt(tabId, [base, ...params].join(' '), 0)
      return true
    }
  },
  {
    name: 'spell',
    description: 'Text checking: spelling languages, or grammar in the docs editor',
    hint: '<off|en|nl|en+nl|grammar>',
    runOnPick: true,
    validate: (arg) => !!parseSpellArg(arg),
    complete: async () => {
      const active = isActiveSpellChoice(getSpellConfig())
      return SPELL_CHOICES.map((c) => ({
        label: c.label,
        value: c.value,
        detail: active(c.value) ? `${c.detail} (current)` : c.detail
      }))
    },
    run: ({ arg }) => {
      const parsed = parseSpellArg(arg)
      if (parsed) setSpellConfig(parsed)
      return true
    }
  }
]

/** The runnable `!npm …` line for a script (trailing space invites params). */
function npmRunLine(s: NpmScript): string {
  const prefix = s.dir ? `--prefix ${quoteArg(s.dir)} ` : ''
  return `!npm ${prefix}run ${quoteArg(s.name)} `
}

function quoteArg(v: string): string {
  return /[^\w./:@-]/.test(v) ? JSON.stringify(v) : v
}

const SPELL_CHOICES = [
  { label: 'en+nl', value: 'en+nl', detail: 'Spelling: English and Dutch' },
  { label: 'en', value: 'en', detail: 'Spelling: English only' },
  { label: 'nl', value: 'nl', detail: 'Spelling: Dutch only' },
  { label: 'grammar on', value: 'grammar', detail: 'Grammar in the docs editor' },
  { label: 'grammar off', value: 'nogrammar', detail: 'No grammar checking' },
  { label: 'off', value: 'off', detail: 'No spelling, no grammar' }
]

/** Which menu entry matches the live config, so it can be marked "(current)". */
function isActiveSpellChoice(c: SpellConfig): (value: string) => boolean {
  return (value) => {
    if (value === 'off') return !c.enabled
    if (value === 'grammar') return c.enabled && c.grammar
    if (value === 'nogrammar') return !c.grammar
    return c.enabled && c.langs.join('+') === value
  }
}

/**
 * `off` / `on`, `grammar` / `nogrammar`, or a `+`-joined language list. Anything
 * unrecognised returns null, which sends the line to claude instead.
 */
function parseSpellArg(arg: string): SpellConfig | null {
  const value = arg.trim().toLowerCase()
  const current = getSpellConfig()
  if (value === 'off') return { ...current, enabled: false }
  if (value === 'on' || value === '') return { ...current, enabled: true }
  if (value === 'grammar') return { ...current, enabled: true, grammar: true }
  if (value === 'nogrammar') return { ...current, grammar: false }
  const langs = value.split(/[+,\s]+/)
  if (!langs.every((l): l is SpellLang => l === 'en' || l === 'nl')) return null
  return { ...current, enabled: true, langs: [...new Set(langs)] }
}

const byName = new Map(APP_COMMANDS.map((c) => [c.name, c]))

export function getAppCommand(name: string): AppCommand | undefined {
  return byName.get(name)
}

// claude's own commands we don't intercept but DO assist with a directory
// picker for their path argument; the full "/name <path>" still goes to claude.
const PATH_COMMANDS = new Set(['add-dir'])

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
