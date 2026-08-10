import * as pty from 'node-pty'
import { basename } from 'path'
import type { TabId } from '../shared/types'
import { loginShellEnv, resolveClaudePath, resolveShell } from './shell-env'
import { buildSettingsOverlay, setupClaudeLauncher } from './settings-overlay'

/** Delay between the bracketed-paste close and the submitting \r, so the TUI
 *  ingests the paste as prompt text before Enter arrives. */
const SUBMIT_DELAY_MS = 50

/** Claude Code reads each pasted image path from disk *asynchronously* to build
 *  its [Image #N] chip; an Enter that arrives mid-read is dropped and the prompt
 *  never sends. Give image prompts a base grace period plus per-image slack. */
const IMAGE_SUBMIT_BASE_MS = 350
const IMAGE_SUBMIT_PER_IMAGE_MS = 300

/** For non-zsh shells we can't hook rc startup, so inject the resume command
 *  into the PTY once the shell has had time to become interactive. */
const RESUME_INJECT_MS = 1200

/** How long after a `--resume` we keep watching for the CLI refusing it because
 *  the session is running as a background agent (see watchBgRefusal). Long
 *  enough to cover a slow launch, short enough that the phrase can't be
 *  mistaken for the session's own later output. */
const REFUSAL_WATCH_MS = 30_000

/** The refusal, whitespace-stripped: "Session <id> is currently running as a
 *  background agent (bg). Use `claude agents` to find and attach to it, …" */
const BG_REFUSAL = 'iscurrentlyrunningasabackgroundagent'

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
  /** Set while we watch a just-issued `--resume` for the background-agent
   *  refusal; cleared once it fires or the window closes. */
  refusal: { sessionId: string; buf: string; timer: NodeJS.Timeout } | null
}

export class PtyManager {
  private tabs = new Map<TabId, TabPty>()

  constructor(
    private getServerInfo: () => { port: number; token: string },
    private emit: {
      data: (tabId: TabId, data: string) => void
      exit: (tabId: TabId, exitCode: number) => void
      /** A `--resume` was refused because the session is running as a
       *  background agent; ipc.ts resolves its job id and attaches instead. */
      resumeRefused?: (tabId: TabId, sessionId: string) => void
    }
  ) {}

  /**
   * Spawn the user's shell as a plain terminal. Running `claude` inside it is
   * wrapped (see setupClaudeLauncher) to inject our --settings overlay, so a
   * session's hooks/statusline feed this app and toggle the Claude UI. The
   * overlay JSON travels in CLAUDE_TERM_SETTINGS so the wrapper can add it.
   */
  /**
   * @param resume  session id to `claude --resume` (ordinary conversations)
   * @param attach  background-agent *job id* to `claude attach` instead. A
   *   session promoted to a daemon-managed background agent can't be resumed
   *   while the daemon keeps it alive (`--resume` errors "running as a
   *   background agent"); it must be attached. ipc.ts decides which to pass by
   *   consulting the live agent list. `resume` and `attach` are exclusive.
   */
  async create(tabId: TabId, cwd: string, resume?: string, attach?: string): Promise<void> {
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
    // zsh resumes/attaches via our .zshrc (no race); other shells get PTY
    // injection below. attach takes precedence over resume (mutually exclusive).
    if (attach && isZsh) spawnEnv.CLAUDE_TERM_ATTACH = attach
    else if (resume && isZsh) spawnEnv.CLAUDE_TERM_RESUME = resume

    const proc = pty.spawn(shell, ['-il'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: spawnEnv
    })

    const tab: TabPty = { proc, cwd, cols, rows, exited: false, refusal: null }
    this.tabs.set(tabId, tab)
    if (resume) this.watchBgRefusal(tab, resume)
    proc.onData((data) => {
      if (tab.refusal) this.checkBgRefusal(tabId, tab, data)
      this.emit.data(tabId, data)
    })
    proc.onExit(({ exitCode }) => {
      tab.exited = true
      this.clearRefusalWatch(tab)
      this.emit.exit(tabId, exitCode)
    })

    if ((attach || resume) && !isZsh) {
      // attach bypasses our `claude` wrapper (which appends --settings): the
      // running agent already has its own settings, and `claude attach` rejects
      // extra flags. Resolve the real binary so the shim's PATH shadowing of
      // `claude` doesn't turn `claude attach` into `claude --settings … attach`.
      const realClaude = attach ? await resolveClaudePath() : null
      const cmd = attach ? `"${realClaude}" attach ${attach}` : `claude --resume ${resume}`
      setTimeout(() => {
        const current = this.tabs.get(tabId)
        if (current && !current.exited) current.proc.write(`${cmd}\r`)
      }, RESUME_INJECT_MS)
    }
  }

  /**
   * A session that was promoted to a daemon-managed background agent can only be
   * attached, never `--resume`d — and whether it counts as "running" is the
   * daemon's call at that instant, so our pre-flight check (ipc.ts) can lose the
   * race and pick a resume the CLI then refuses. Watch the tab's output for that
   * refusal and hand it back to ipc.ts, which attaches instead: without this the
   * tab is left as a bare shell showing an error, and the conversation looks lost.
   */
  private watchBgRefusal(tab: TabPty, sessionId: string): void {
    tab.refusal = {
      sessionId,
      buf: '',
      timer: setTimeout(() => this.clearRefusalWatch(tab), REFUSAL_WATCH_MS)
    }
  }

  private clearRefusalWatch(tab: TabPty): void {
    if (!tab.refusal) return
    clearTimeout(tab.refusal.timer)
    tab.refusal = null
  }

  /** Stop watching a tab for the refusal. Called once a real session reports in
   *  (see ipc.ts): the refusal can only precede that, so anything the session
   *  itself writes about background agents must not be mistaken for it. */
  stopRefusalWatch(tabId: TabId): void {
    const tab = this.tabs.get(tabId)
    if (tab) this.clearRefusalWatch(tab)
  }

  /** Both the refusal phrase and the resumed session id must appear before we
   *  act. Escapes are stripped from the whole accumulated tail rather than
   *  per chunk — a PTY read can split an escape sequence down the middle, and
   *  the leftover bytes would then sit inside the phrase we're looking for.
   *  Whitespace goes too, because the message hard-wraps at the tab width. */
  private checkBgRefusal(tabId: TabId, tab: TabPty, data: string): void {
    const watch = tab.refusal
    if (!watch) return
    watch.buf = (watch.buf + data).slice(-8192)
    const clean = watch.buf
      // eslint-disable-next-line no-control-regex -- stripping escapes needs ESC
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex -- as above
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      // eslint-disable-next-line no-control-regex -- as above
      .replace(/\x1b./g, '')
      .replace(/\s+/g, '')
    if (!clean.includes(BG_REFUSAL) || !clean.includes(watch.sessionId)) return
    const sessionId = watch.sessionId
    this.clearRefusalWatch(tab)
    this.emit.resumeRefused?.(tabId, sessionId)
  }

  /** Attach a background agent in a tab whose shell is already sitting at a
   *  prompt (recovery after a refused resume). Bypasses the `claude` wrapper:
   *  `claude attach` takes no --settings (see create). */
  async attachInPlace(tabId: TabId, jobId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.exited) return
    const realClaude = await resolveClaudePath()
    const current = this.tabs.get(tabId)
    if (current && !current.exited) current.proc.write(`"${realClaude}" attach ${jobId}\r`)
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

  /** Inject a (possibly multiline) prompt: bracketed paste, then submit. When
   *  the prompt carries images, wait longer before Enter so Claude Code finishes
   *  reading them into [Image #N] chips (see IMAGE_SUBMIT_* above). */
  injectPrompt(tabId: TabId, text: string, imageCount = 0): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.exited || !text) return
    tab.proc.write(`\x1b[200~${text}\x1b[201~`)
    const delay =
      imageCount > 0
        ? IMAGE_SUBMIT_BASE_MS + imageCount * IMAGE_SUBMIT_PER_IMAGE_MS
        : SUBMIT_DELAY_MS
    setTimeout(() => {
      const current = this.tabs.get(tabId)
      if (current && !current.exited) current.proc.write('\r')
    }, delay)
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

  /** Kill every pty and resolve once each exit callback has been delivered.
   *  Quitting while node-pty's exit events are still queued aborts the whole
   *  process: the ThreadSafeFunction fires into the dying Node environment and
   *  the resulting napi throw terminates (SIGABRT). */
  disposeAll(timeoutMs = 1500): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [tabId, tab] of this.tabs) {
      if (!tab.exited) {
        pending.push(new Promise((resolve) => tab.proc.onExit(() => resolve())))
        try {
          tab.proc.kill()
        } catch {
          /* already dead — its exit event resolves the waiter */
        }
      }
      this.tabs.delete(tabId)
    }
    if (pending.length === 0) return Promise.resolve()
    // Backstop: a wedged shell must not hold the quit hostage.
    return Promise.race([
      Promise.all(pending).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
  }
}
