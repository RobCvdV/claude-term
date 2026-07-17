import * as pty from 'node-pty'
import { basename } from 'path'
import type { TabId } from '../shared/types'
import { loginShellEnv, resolveShell } from './shell-env'
import { buildSettingsOverlay, setupClaudeLauncher } from './settings-overlay'

/** Delay between the bracketed-paste close and the submitting \r, so the TUI
 *  ingests the paste as prompt text before Enter arrives. */
const SUBMIT_DELAY_MS = 50

/** For non-zsh shells we can't hook rc startup, so inject the resume command
 *  into the PTY once the shell has had time to become interactive. */
const RESUME_INJECT_MS = 1200

/**
 * Claude Code marks its own environment so a `claude` launched from within a
 * running session behaves as a *child* session — ephemeral id, no persisted
 * conversation. If claude-term itself is launched from inside a claude session
 * (or an integrated terminal running one), those markers leak into the shells
 * we spawn and quietly break session persistence + --resume. Scrub them so
 * every `claude` started in a tab is a clean top-level session.
 */
const NESTED_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH'
]

interface TabPty {
  proc: pty.IPty
  cwd: string
  cols: number
  rows: number
  exited: boolean
}

export class PtyManager {
  private tabs = new Map<TabId, TabPty>()

  constructor(
    private getServerInfo: () => { port: number; token: string },
    private emit: {
      data: (tabId: TabId, data: string) => void
      exit: (tabId: TabId, exitCode: number) => void
    }
  ) {}

  /**
   * Spawn the user's shell as a plain terminal. Running `claude` inside it is
   * wrapped (see setupClaudeLauncher) to inject our --settings overlay, so a
   * session's hooks/statusline feed this app and toggle the Claude UI. The
   * overlay JSON travels in CLAUDE_TERM_SETTINGS so the wrapper can add it.
   */
  async create(tabId: TabId, cwd: string, resume?: string): Promise<void> {
    const [env, shell] = await Promise.all([loginShellEnv(), resolveShell()])
    const launcherEnv = await setupClaudeLauncher(shell)
    const { port, token } = this.getServerInfo()
    const overlay = buildSettingsOverlay(port, tabId, token)
    const existing = this.tabs.get(tabId)
    const cols = existing?.cols ?? 80
    const rows = existing?.rows ?? 24
    const isZsh = basename(shell).includes('zsh')

    const spawnEnv: { [key: string]: string } = {
      ...env,
      ...launcherEnv,
      COLORTERM: 'truecolor',
      CLAUDE_TERM_TAB_ID: tabId,
      CLAUDE_TERM_PORT: String(port),
      CLAUDE_TERM_TOKEN: token,
      CLAUDE_TERM_SETTINGS: overlay
    }
    for (const key of NESTED_CLAUDE_ENV) delete spawnEnv[key]
    // zsh resumes via our .zshrc (no race); other shells get PTY injection below
    if (resume && isZsh) spawnEnv.CLAUDE_TERM_RESUME = resume

    const proc = pty.spawn(shell, ['-il'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: spawnEnv
    })

    const tab: TabPty = { proc, cwd, cols, rows, exited: false }
    this.tabs.set(tabId, tab)
    proc.onData((data) => this.emit.data(tabId, data))
    proc.onExit(({ exitCode }) => {
      tab.exited = true
      this.emit.exit(tabId, exitCode)
    })

    if (resume && !isZsh) {
      setTimeout(() => {
        const current = this.tabs.get(tabId)
        if (current && !current.exited) current.proc.write(`claude --resume ${resume}\r`)
      }, RESUME_INJECT_MS)
    }
  }

  /** Respawn a fresh shell in the same tab/cwd (after the shell exited). */
  async restart(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (!tab.exited) tab.proc.kill()
    await this.create(tabId, tab.cwd)
  }

  write(tabId: TabId, data: string): void {
    const tab = this.tabs.get(tabId)
    if (tab && !tab.exited) tab.proc.write(data)
  }

  /** Inject a (possibly multiline) prompt: bracketed paste, then submit. */
  injectPrompt(tabId: TabId, text: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.exited || !text) return
    tab.proc.write(`\x1b[200~${text}\x1b[201~`)
    setTimeout(() => {
      const current = this.tabs.get(tabId)
      if (current && !current.exited) current.proc.write('\r')
    }, SUBMIT_DELAY_MS)
  }

  resize(tabId: TabId, cols: number, rows: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.cols = cols
    tab.rows = rows
    if (!tab.exited) tab.proc.resize(cols, rows)
  }

  isBusyCandidate(tabId: TabId): boolean {
    const tab = this.tabs.get(tabId)
    return !!tab && !tab.exited
  }

  kill(tabId: TabId): void {
    const tab = this.tabs.get(tabId)
    if (tab && !tab.exited) tab.proc.kill()
    this.tabs.delete(tabId)
  }

  killAll(): void {
    for (const tabId of [...this.tabs.keys()]) this.kill(tabId)
  }
}
