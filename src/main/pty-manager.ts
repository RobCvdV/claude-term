import * as pty from 'node-pty'
import type { TabId } from '../shared/types'
import { loginShellEnv, resolveClaudePath } from './shell-env'
import { buildSettingsOverlay } from './settings-overlay'

/** Delay between the bracketed-paste close and the submitting \r, so the TUI
 *  ingests the paste as prompt text before Enter arrives. */
const SUBMIT_DELAY_MS = 50

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

  async create(tabId: TabId, cwd: string, extraArgs: string[] = []): Promise<void> {
    const [env, claudePath] = await Promise.all([loginShellEnv(), resolveClaudePath()])
    const { port, token } = this.getServerInfo()
    const overlay = buildSettingsOverlay(port, tabId, token)
    const existing = this.tabs.get(tabId)
    const cols = existing?.cols ?? 80
    const rows = existing?.rows ?? 24

    const proc = pty.spawn(claudePath, [...extraArgs, '--settings', overlay], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...env,
        COLORTERM: 'truecolor',
        CLAUDE_TERM_TAB_ID: tabId,
        CLAUDE_TERM_PORT: String(port),
        CLAUDE_TERM_TOKEN: token
      } as { [key: string]: string }
    })

    const tab: TabPty = { proc, cwd, cols, rows, exited: false }
    this.tabs.set(tabId, tab)
    proc.onData((data) => this.emit.data(tabId, data))
    proc.onExit(({ exitCode }) => {
      tab.exited = true
      this.emit.exit(tabId, exitCode)
    })
  }

  /**
   * Respawn claude in the same tab/cwd. Resuming targets the tab's own
   * session id — `-c` would grab the most recent session in that cwd, which
   * may belong to a different claude instance entirely.
   */
  async restart(tabId: TabId, resumeSessionId: string | null): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (!tab.exited) tab.proc.kill()
    await this.create(tabId, tab.cwd, resumeSessionId ? ['--resume', resumeSessionId] : [])
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
