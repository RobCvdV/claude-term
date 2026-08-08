import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import type { DocGroup, PersistedSession, TabId, TabInfo } from '../shared/types'
import { PtyManager } from './pty-manager'
import { StatusServer } from './status-server'
import { listBranches, listCommands, listDirs, searchFiles } from './completions'
import { switchBranch } from './git-actions'
import { jobIdForRefusedResume, resolveRevive, warmLiveAgents } from './agents'
import { buildActivityReport } from './activity-log'
import { listProjectDocs, openDoc, readDoc, writeDoc } from './docs'
import { closeDocsWindowForTab, openOrFocusDocsWindow } from './docs-window'
import { listConfigFiles, readConfigFile, writeConfigFile } from './config-files'
import { closeConfigWindowForTab, openOrFocusConfigWindow } from './config-window'
import { addedDirFromPrompt, mergeAddedDirs } from './added-dirs'
import { sessionHomeDir } from './session-home'
import { settingsAddedDirs } from './project-dirs'
import { readLoggedWorklogs, saveWorklogPlan } from './worklog-store'
import { bookWorklogs, fetchBooked, jiraConnect, jiraDisconnect, jiraStatus } from './jira-client'
import { getVolume, setVolume } from './volume'
import { showFolderContextMenu } from './folder-context-menu'
import { listOpenPrs, showPrContextMenu } from './pr-list'
import { sessionDoing } from './session-summary'
import { RateStore } from './rate-store'
import { parseRemote } from '../shared/repo-links'
import type { PrInfo } from '../shared/types'
import type { VolumeOp, WorklogPlan, WorklogPlanEntry } from '../shared/types'

export interface AppServices {
  ptys: PtyManager
  status: StatusServer
  rate: RateStore
}

export function createServices(getWindow: () => BrowserWindow | null): AppServices {
  const status = new StatusServer()
  // rate limits are account-global: every tab's payload feeds one shared store
  const rate = new RateStore(() => join(app.getPath('userData'), 'rate-samples.jsonl'))

  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const ptys = new PtyManager(() => ({ port: status.port, token: status.token }), {
    data: (tabId, data) => send('pty:data', tabId, data),
    exit: (tabId, exitCode) => {
      status.markExited(tabId, exitCode)
      send('pty:exit', tabId, exitCode)
    },
    // The resume we chose was refused because the daemon has the session as a
    // live background agent — attach to it instead of leaving a dead tab.
    resumeRefused: (tabId, sessionId) => {
      void jobIdForRefusedResume(sessionId).then((jobId) => {
        if (jobId) void ptys.attachInPlace(tabId, jobId)
      })
    }
  })

  status.onUpdate = (tabStatus) => {
    // A statusline arrived → the tab has a real session rendering, so a
    // background-agent refusal can no longer be ahead of us (see
    // PtyManager.stopRefusalWatch).
    if (tabStatus.payload) {
      ptys.stopRefusalWatch(tabStatus.tabId)
      rate.record(tabStatus.payload)
    }
    send('status:update', tabStatus)
  }
  status.onAttention = (tabId, hookEvent) => send('tab:attention', tabId, hookEvent)
  // A branch switch renames the live session (name has no spaces → no quoting).
  status.onRenameSession = (tabId, name) => ptys.injectPrompt(tabId, `/rename ${name}`)
  return { ptys, status, rate }
}

export function registerIpc(services: AppServices, getWindow: () => BrowserWindow | null): void {
  const { ptys, status } = services

  // Started when the renderer loads the persisted session (which is where we
  // first see every id about to be revived) and awaited by each revive.
  let agentWarmup: Promise<void> | null = null
  const awaitAgentWarmup = async (): Promise<void> => {
    if (agentWarmup) await agentWarmup
  }

  ipcMain.handle(
    'tab:create',
    async (_e, cwd?: string, resume?: string, addedDirs?: string[]): Promise<TabInfo> => {
      // a persisted cwd may no longer exist — fall back to home rather than fail
      let dir = cwd && existsSync(cwd) ? cwd : homedir()
      const tabId: TabId = randomUUID()
      // Resolve how to restore a persisted session (only when `resume` is set):
      //  - live daemon-managed background agent → `claude attach` (--resume
      //    refuses a live bg session);
      //  - resumable transcript on disk → `claude --resume`;
      //  - neither (id outlived its transcript / was never written) → plain
      //    shell, so we don't dump "No conversation found" into the tab.
      // Waits for the daemon to be answerable first (see warmLiveAgents): asking
      // too early reports no agents and we'd pick a --resume the daemon refuses.
      let target: Awaited<ReturnType<typeof resolveRevive>> | null = null
      if (resume) {
        await awaitAgentWarmup()
        target = await resolveRevive(resume)
        // Revive from the conversation's own home: `--resume` from any other
        // directory re-homes the conversation (the CLI moves its transcript to
        // the launch dir), silently dragging it into whatever folder the tab
        // spawned in. The tab follows its conversation, spawn dir included.
        if (target.mode !== 'shell') {
          const home = sessionHomeDir(resume)
          if (home && existsSync(home)) dir = home
        }
      }
      // added dirs: the persisted tab record plus the project's own settings
      // (additionalDirectories) — the latter never show up in /add-dir prompts
      // or statusline added_dirs, so this is their only way into the UI
      const seeded = [...new Set([...(addedDirs ?? []), ...settingsAddedDirs(dir)])]
      status.registerTab(tabId, dir, seeded.filter(existsSync))
      if (target) {
        if (target.mode === 'attach') {
          await ptys.create(tabId, dir, undefined, target.jobId)
        } else if (target.mode === 'resume') {
          await ptys.create(tabId, dir, resume)
        } else {
          await ptys.create(tabId, dir)
        }
        // Both revive paths self-report via statusline within ~1s, but seed the UI
        // now so the prompt box doesn't flicker in — and an attached bg agent
        // never reports at all (its --settings point at a dead endpoint), so this
        // is the only thing that shows its Claude UI and keeps its session id
        // in the persisted state for the next launch.
        if (target.mode !== 'shell') status.markClaudeActive(tabId, resume)
      } else {
        await ptys.create(tabId, dir)
      }
      return { tabId, cwd: dir, title: basename(dir) || dir }
    }
  )

  ipcMain.handle('tab:close', async (_e, tabId: TabId) => {
    // Flush the detached windows first (they may prompt to save) while the tab's
    // status — and thus their cwd/roots — is still resolvable.
    await closeDocsWindowForTab(tabId)
    await closeConfigWindowForTab(tabId)
    ptys.kill(tabId)
    status.removeTab(tabId)
  })

  ipcMain.on('docs:openWindow', (_e, tabId: TabId, group: DocGroup, title: string) => {
    openOrFocusDocsWindow(tabId, group, title)
  })

  ipcMain.on('config:openWindow', (_e, tabId: TabId, title: string) => {
    openOrFocusConfigWindow(tabId, title)
  })

  ipcMain.handle('tab:restart', async (_e, tabId: TabId) => {
    status.markRestarted(tabId)
    await ptys.restart(tabId)
  })

  ipcMain.handle('dialog:pickFolder', async (): Promise<string | null> => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose the project folder for the new Claude Code session'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Open terminal links in the user's real browser, not the app window.
  // Only http(s) — never file:// or other schemes from arbitrary terminal output.
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle('shell:openFolder', (_e, dir: string) => {
    if (existsSync(dir)) void shell.openPath(dir)
  })

  ipcMain.on('folder:contextMenu', (e, dir: string) => {
    if (!existsSync(dir)) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) showFolderContextMenu(win, dir)
  })

  // Status-bar PR dropdown: open PRs of the tab repo, and per-PR context menu.
  const tabRepo = (tabId: TabId): { cwd: string; repo: ReturnType<typeof parseRemote> } | null => {
    const snap = status.snapshot(tabId)
    const repo = snap?.git?.remoteUrl ? parseRemote(snap.git.remoteUrl) : null
    return repo && snap ? { cwd: snap.cwd, repo } : null
  }

  ipcMain.handle('prs:list', async (_e, tabId: TabId): Promise<PrInfo[]> => {
    const target = tabRepo(tabId)
    return target?.repo ? listOpenPrs(target.cwd, target.repo) : []
  })

  ipcMain.on('prs:contextMenu', (e, tabId: TabId, pr: PrInfo) => {
    const target = tabRepo(tabId)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (target?.repo && win) showPrContextMenu(win, target.cwd, target.repo, pr)
  })

  ipcMain.handle('status:snapshot', (_e, tabId: TabId) => status.snapshot(tabId))

  // Mission control: one-line "doing" snippet from the tab session's transcript
  // tail. `wanted` drops a queued Bonsai job once the tab is gone.
  ipcMain.handle('mission:doing', (_e, tabId: TabId): Promise<string | null> => {
    const sessionId = status.snapshot(tabId)?.sessionId
    if (!sessionId) return Promise.resolve(null)
    return sessionDoing(sessionId, () => status.snapshot(tabId) !== null)
  })

  // Rate-limit burn forecast, from the shared sample store (see createServices).
  ipcMain.handle('rate:forecast', () => services.rate.forecast())

  // Activity-hours overview: aggregate the global heartbeat log (written by
  // ~/.claude/hooks/log-activity.sh) into engaged hours per ticket per day.
  ipcMain.handle('activity:report', (_e, rangeDays: number) => buildActivityReport(rangeDays))

  // Worklog prep: the panel saves a confirmed dispatch for the assistant to post
  // via the Atlassian MCP; the log of what's already been posted drives ✓ badges.
  ipcMain.handle('worklog:savePlan', (_e, plan: WorklogPlan) => saveWorklogPlan(plan))
  ipcMain.handle('worklog:logged', () => readLoggedWorklogs())

  // Direct Jira REST: read what's already booked, post new worklogs — no
  // assistant round-trip needed once a token is connected.
  ipcMain.handle('jira:status', () => jiraStatus())
  ipcMain.handle('jira:connect', (_e, email: string, token: string) => jiraConnect(email, token))
  ipcMain.handle('jira:disconnect', () => jiraDisconnect())
  ipcMain.handle('jira:booked', (_e, rangeDays: number) => fetchBooked(rangeDays))
  ipcMain.handle('jira:book', (_e, entries: WorklogPlanEntry[]) => bookWorklogs(entries))

  // Notification volume: reflects/controls the audio-notifications plugin's live
  // scale knob (shared across all Claude sessions).
  ipcMain.handle('volume:get', () => getVolume())
  ipcMain.handle('volume:set', (_e, op: VolumeOp) => setVolume(op))

  // dev/scripting convenience: auto-open a tab in this folder at startup
  ipcMain.handle('app:initialCwd', () => process.env.CLAUDE_TERM_DEFAULT_CWD ?? null)

  // Harper's grammar engine, as raw wasm bytes. The renderer can't fetch it
  // itself — the packaged app runs from file://, where fetch is blocked — so it
  // travels over IPC and becomes a blob: URL there. Copied into resources/ by
  // postinstall (see scripts/copy-harper-wasm.mjs); missing file = no grammar.
  ipcMain.handle('grammar:wasm', () => {
    const wasm = join(__dirname, '../../resources/harper-grammar.wasm')
    try {
      return readFileSync(wasm)
    } catch {
      return null
    }
  })

  // tab/session persistence across launches
  const sessionFile = join(app.getPath('userData'), 'session.json')
  const readSession = (): PersistedSession | null => {
    try {
      return JSON.parse(readFileSync(sessionFile, 'utf8')) as PersistedSession
    } catch {
      return null
    }
  }
  // Every distinct previous state is snapshotted before being overwritten, so
  // a clobbered tab list (crashed instance, stray writer, future bug) is always
  // recoverable from session-backups/ — restore = copy one over session.json.
  const backupDir = join(app.getPath('userData'), 'session-backups')
  const KEEP_BACKUPS = 20
  const backupSession = (next: string): void => {
    const prev = readFileSync(sessionFile, 'utf8')
    if (prev === next) return
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(backupDir, `session-${stamp}.json`), prev)
    const old = readdirSync(backupDir)
      .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
      .sort()
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
      unlinkSync(join(backupDir, f))
    }
  }
  const writeSession = (state: PersistedSession): void => {
    try {
      const next = JSON.stringify(state, null, 2)
      try {
        backupSession(next)
      } catch {
        /* no previous file, or backup failed — still write the new state */
      }
      writeFileSync(sessionFile, next)
    } catch {
      /* best effort — a failed save just means no restore next launch */
    }
  }
  ipcMain.handle('session:load', () => {
    const state = readSession()
    // Kick off daemon warm-up for the sessions this launch is about to revive,
    // so the first tab:create doesn't have to decide against a cold daemon.
    const ids = (state?.tabs ?? [])
      .filter((t) => t.claudeActive && t.sessionId)
      .map((t) => t.sessionId as string)
    if (ids.length > 0) agentWarmup = warmLiveAgents(ids)
    return state
  })
  ipcMain.handle('session:save', (_e, state: PersistedSession) => writeSession(state))
  // synchronous variant for beforeunload, where async IPC may not finish
  ipcMain.on('session:saveSync', (e, state: PersistedSession) => {
    writeSession(state)
    e.returnValue = true
  })

  ipcMain.handle('docs:list', (_e, tabId: TabId) => {
    const cwd = status.getCwd(tabId)
    return cwd ? listProjectDocs(cwd) : { plans: [], roadmap: null, sections: [] }
  })
  ipcMain.handle('docs:read', (_e, tabId: TabId, path: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? readDoc(cwd, path) : null
  })
  ipcMain.handle('docs:open', (_e, tabId: TabId, path: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? openDoc(cwd, path) : false
  })
  ipcMain.handle('docs:write', (_e, tabId: TabId, path: string, content: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? writeDoc(cwd, path, content) : false
  })

  // Project configuration files (the status-bar Settings window). Roots are the
  // tab's cwd plus its added directories — resolved here, never passed in.
  const configPatternsFile = join(app.getPath('userData'), 'config-file-patterns.json')
  const rootsFor = (tabId: TabId): { cwd: string | null; addedDirs: string[] } => {
    const cwd = status.getCwd(tabId)
    return { cwd, addedDirs: cwd ? mergeAddedDirs(cwd, status.getAddedDirs(tabId)) : [] }
  }

  ipcMain.handle('config:list', (_e, tabId: TabId) => {
    const { cwd, addedDirs } = rootsFor(tabId)
    return cwd
      ? listConfigFiles(cwd, addedDirs, configPatternsFile)
      : { sections: [], patternsFile: configPatternsFile }
  })
  ipcMain.handle('config:read', (_e, tabId: TabId, path: string) => {
    const { cwd, addedDirs } = rootsFor(tabId)
    return cwd ? readConfigFile(cwd, addedDirs, configPatternsFile, path) : null
  })
  ipcMain.handle('config:write', (_e, tabId: TabId, path: string, content: string) => {
    const { cwd, addedDirs } = rootsFor(tabId)
    return cwd ? writeConfigFile(cwd, addedDirs, configPatternsFile, path, content) : false
  })

  ipcMain.handle('completions:commands', (_e, tabId: TabId) => {
    const cwd = status.getCwd(tabId)
    return cwd ? listCommands(cwd) : []
  })

  ipcMain.handle('completions:files', (_e, tabId: TabId, query: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? searchFiles(cwd, query) : []
  })

  ipcMain.handle('completions:branches', (_e, tabId: TabId, query: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? listBranches(cwd, query) : []
  })

  ipcMain.handle('completions:dirs', (_e, tabId: TabId, query: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? listDirs(cwd, query) : []
  })

  ipcMain.handle('git:switch', (_e, tabId: TabId, branch: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? switchBranch(cwd, branch) : { ok: false, error: 'no working directory' }
  })

  ipcMain.on('pty:input', (_e, tabId: TabId, data: string) => ptys.write(tabId, data))
  ipcMain.on('pty:resize', (_e, tabId: TabId, cols: number, rows: number) =>
    ptys.resize(tabId, cols, rows)
  )
  ipcMain.on('prompt:submit', (_e, tabId: TabId, text: string, imageCount?: number) => {
    // `/add-dir` is claude's own command — we don't intercept it, but this is the
    // only place the app can observe one, so note the folder for the Settings
    // window (see added-dirs.ts for why there is no other source).
    const cwd = status.getCwd(tabId)
    if (cwd) {
      const dir = addedDirFromPrompt(text, cwd)
      if (dir && existsSync(dir)) status.addDirectory(tabId, dir)
    }
    ptys.injectPrompt(tabId, text, imageCount ?? 0)
  })
}
