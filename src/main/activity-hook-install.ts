import { app, dialog, type BrowserWindow } from 'electron'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Self-installs the global activity-logging hook into the user's Claude Code
 * config, so every session (this app AND plain terminals) feeds the 🕐 Activity
 * hours view. Mirrors settings-overlay's installForwarder: copy the script out
 * of resources, then wire it into ~/.claude/settings.json.
 *
 * Safe by construction: merge-only (never touches other hooks), idempotent,
 * asks once on first run, remembers the choice, and bails rather than clobber a
 * settings.json it can't parse.
 */

const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd']
const HOOK_COMMAND = 'bash ~/.claude/hooks/log-activity.sh'
const MARKER = 'log-activity.sh'

interface HookCmd {
  type?: string
  command?: string
}
interface HookGroup {
  matcher?: string
  hooks?: HookCmd[]
}
interface Settings {
  hooks?: Record<string, HookGroup[]>
  [key: string]: unknown
}

const claudeDir = join(homedir(), '.claude')
const settingsPath = join(claudeDir, 'settings.json')
const hookDest = join(claudeDir, 'hooks', 'log-activity.sh')

function statePath(): string {
  return join(app.getPath('userData'), 'activity-hook-state.json')
}
function readDecision(): 'installed' | 'declined' | null {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8')) as { decision?: string }
    return s.decision === 'installed' || s.decision === 'declined' ? s.decision : null
  } catch {
    return null
  }
}
function writeDecision(decision: 'installed' | 'declined'): void {
  try {
    writeFileSync(statePath(), JSON.stringify({ decision, at: Date.now() }, null, 2))
  } catch {
    /* best effort */
  }
}

/** Copy the bundled script into ~/.claude/hooks (keeps it current). */
function installScript(): void {
  const source = join(__dirname, '../../resources/log-activity.sh')
  mkdirSync(join(claudeDir, 'hooks'), { recursive: true })
  copyFileSync(source, hookDest)
  chmodSync(hookDest, 0o755)
}

function isRegistered(settings: Settings): boolean {
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        if (typeof h.command === 'string' && h.command.includes(MARKER)) return true
      }
    }
  }
  return false
}

/** Add our hook to each event it isn't already on; leaves everything else. */
function mergeHooks(settings: Settings): void {
  const hooks = (settings.hooks ??= {})
  for (const event of EVENTS) {
    const groups = (hooks[event] ??= [])
    const present = groups.some((g) =>
      (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER))
    )
    if (!present) groups.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] })
  }
}

function install(): void {
  installScript()
  let settings: Settings = {}
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings
  } catch {
    // exists but unparseable → refuse to overwrite; a fresh file is fine.
    if (existsSync(settingsPath)) return
  }
  mergeHooks(settings)
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    writeDecision('installed')
  } catch {
    /* best effort */
  }
}

export async function ensureActivityHook(getWindow: () => BrowserWindow | null): Promise<void> {
  let settings: Settings = {}
  let unparseable = false
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings
  } catch {
    unparseable = existsSync(settingsPath)
  }

  // Already wired up (incl. by a previous run) → just refresh the script.
  if (!unparseable && isRegistered(settings)) {
    try {
      installScript()
    } catch {
      /* ignore */
    }
    return
  }

  // Asked before, or a settings.json we mustn't touch → do nothing.
  if (readDecision() !== null || unparseable) return

  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Install', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Track activity hours?',
    message: 'Add claude-term’s time-tracking hook?',
    detail:
      'It adds a hook to your global ~/.claude/settings.json so every Claude Code session logs how long you spend per ticket — the data behind the Activity hours (🕐) view.'
  }
  const win = getWindow()
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (res.response === 0) install()
  else writeDecision('declined')
}
