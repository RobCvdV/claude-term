import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import type {
  ConvoSearchResult,
  CreateDocResult,
  DocGroup,
  DocTarget,
  PersistedSession,
  TabId,
  TabInfo
} from '../shared/types'
import { PtyManager } from './pty-manager'
import { StatusServer } from './status-server'
import { listBranches, listBranchRefs, listCommands, listDirs, searchFiles } from './completions'
import { isWorkspaceRoot, workspaceBranchGroups } from './branch-list'
import { listNpmScripts } from './npm-scripts'
import { switchBranch } from './git-actions'
import { jobIdForRefusedResume, resolveRevive, warmLiveAgents } from './agents'
import { buildActivityReport } from './activity-log'
import {
  createDoc,
  listProjectDocs,
  newFileStartPath,
  openDoc,
  planNewFile,
  revealDoc,
  readDoc,
  writeDoc
} from './docs'
import { insideAny, listTree } from './file-tree'
import { findFiles } from './file-find'
import { resolveFileLink } from './file-link'
import { fileAtHead } from './git-diff'
import { projectChanges } from './turn-changes'
import { readProjectSettings, writeProjectSettings } from './project-settings'
import { dropCheckpoint, revertFiles, takeCheckpoint } from './checkpoints'
import { CheckpointStore } from './checkpoint-store'
import { parseFileLink } from '../shared/file-link'
import { closeDocsWindowForTab, openOrFocusDocsWindow } from './docs-window'
import { listConfigFiles } from './config-files'
import { addedDirFromPrompt, mergeAddedDirs } from './added-dirs'
import { sessionHomeDir } from './session-home'
import { settingsAddedDirs } from './project-dirs'
import { readLoggedWorklogs, saveWorklogPlan } from './worklog-store'
import { bookWorklogs, fetchBooked, jiraConnect, jiraDisconnect, jiraStatus } from './jira-client'
import { getVolume, setVolume } from './volume'
import { showFolderContextMenu } from './folder-context-menu'
import { listOpenPrs, showPrContextMenu } from './pr-list'
import { sessionDoing } from './session-summary'
import { searchConversation } from './conversation-search'
import { RateStore } from './rate-store'
import { BranchHistory } from './branch-history'
import { reflogBranches } from './branch-backfill'
import { parseRemote, type RepoRef } from '../shared/repo-links'
import type {
  PrGroup,
  PrInfo,
  ProjectChanges,
  ProjectSettings,
  ProjectSettingsPatch,
  RevertResult
} from '../shared/types'
import type { VolumeOp, WorklogPlan, WorklogPlanEntry } from '../shared/types'

export interface AppServices {
  ptys: PtyManager
  status: StatusServer
  rate: RateStore
  branches: BranchHistory
  checkpoints: CheckpointStore
}

export function createServices(getWindow: () => BrowserWindow | null): AppServices {
  // stable endpoint (port+token survive restarts) so a background agent's
  // baked-in --settings keep reaching us after an app update
  const status = new StatusServer(() => join(app.getPath('userData'), 'status-endpoint.json'))
  // rate limits are account-global: every tab's payload feeds one shared store
  const rate = new RateStore(() => join(app.getPath('userData'), 'rate-samples.jsonl'))
  const branches = new BranchHistory(() => join(app.getPath('userData'), 'branch-history.json'))
  // a checkpoint pins a commit with a ref, so eviction has to release it
  const checkpoints = new CheckpointStore((cp) => void dropCheckpoint(cp))

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
        if (jobId) {
          void ptys.attachInPlace(tabId, jobId)
          status.markAttached(tabId, sessionId, jobId)
        }
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
  // First sighting of a repo this run: pull its reflog into the history, so
  // branches from before the app (or this feature) existed are recallable too.
  const backfilled = new Set<string>()
  status.onBranchSeen = (root, branch) => {
    branches.record(root, branch)
    if (backfilled.has(root)) return
    backfilled.add(root)
    void reflogBranches(root).then((found) => branches.backfill(root, found))
  }
  // Before the turn's first edit lands: snapshot the working tree, so the whole
  // turn can be undone as a unit. Fire and forget — a turn must never wait on it.
  let turnSeq = 0
  status.onTurnStart = (tabId, cwd) => {
    const id = `${tabId}-${++turnSeq}`
    void takeCheckpoint(cwd, id).then((cp) => {
      if (cp) checkpoints.add(tabId, cp)
    })
  }

  return { ptys, status, rate, branches, checkpoints }
}

export function registerIpc(services: AppServices, getWindow: () => BrowserWindow | null): void {
  const { ptys, status, checkpoints } = services

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
      // Nobody picked that fallback, so the tab has no folder identity to
      // defend: it re-homes onto the first claude session's project dir
      // (see StatusServer.adoptDefaultHome). A chosen folder never does.
      let homeIsDefault = dir !== cwd
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
          if (home && existsSync(home)) {
            dir = home
            homeIsDefault = false // the conversation's own home, not a fallback
          }
        }
      }
      // added dirs: the persisted tab record plus the project's own settings
      // (additionalDirectories) — the latter never show up in /add-dir prompts
      // or statusline added_dirs, so this is their only way into the UI
      const seeded = [...new Set([...(addedDirs ?? []), ...settingsAddedDirs(dir)])]
      status.registerTab(tabId, dir, seeded.filter(existsSync), homeIsDefault)
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
        // an attached agent's own feed POSTs to the endpoint of the app run
        // that launched it — synthesize activity until a real feed shows up
        if (target.mode === 'attach') status.markAttached(tabId, resume as string, target.jobId)
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
    ptys.kill(tabId)
    status.removeTab(tabId)
    checkpoints.forget(tabId)
  })

  ipcMain.on(
    'docs:openWindow',
    (_e, tabId: TabId, group: DocGroup, title: string, target?: DocTarget) => {
      openOrFocusDocsWindow(tabId, group, title, target)
    }
  )

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

  // Status-bar PR dropdown: open PRs of every workspace repo (the tab's own
  // plus added dirs living in other repos), and the per-PR context menu.
  const repoTargets = (tabId: TabId): Array<{ root: string; repo: RepoRef }> => {
    const snap = status.snapshot(tabId)
    if (!snap) return []
    const out: Array<{ root: string; repo: RepoRef }> = []
    const add = (root: string, remoteUrl: string | undefined): void => {
      const repo = remoteUrl ? parseRemote(remoteUrl) : null
      if (repo) out.push({ root, repo })
    }
    add(snap.cwd, snap.git?.remoteUrl)
    for (const r of snap.extraRepos) add(r.root, r.git.remoteUrl)
    return out
  }

  ipcMain.handle('prs:list', async (_e, tabId: TabId): Promise<PrGroup[]> => {
    return Promise.all(
      repoTargets(tabId).map(async ({ root, repo }) => ({
        root,
        prs: await listOpenPrs(root, repo)
      }))
    )
  })

  ipcMain.on('prs:contextMenu', (e, tabId: TabId, pr: PrInfo, root?: string) => {
    const targets = repoTargets(tabId)
    // root comes from the renderer — only ever act on a root we resolved here
    const target = targets.find((t) => t.root === root) ?? targets[0]
    const win = BrowserWindow.fromWebContents(e.sender)
    if (target && win) showPrContextMenu(win, target.root, target.repo, pr)
  })

  ipcMain.handle('status:snapshot', (_e, tabId: TabId) => status.snapshot(tabId))

  // Mission control: one-line "doing" snippet from the tab session's transcript
  // tail. `wanted` drops a queued Bonsai job once the tab is gone.
  ipcMain.handle('mission:doing', (_e, tabId: TabId): Promise<string | null> => {
    const sessionId = status.snapshot(tabId)?.sessionId
    if (!sessionId) return Promise.resolve(null)
    return sessionDoing(sessionId, () => status.snapshot(tabId) !== null)
  })

  // ⌘F over the conversation itself: the tab's session transcript, since the
  // TUI's own history never reaches the terminal's scrollback.
  ipcMain.handle(
    'convo:search',
    (_e, tabId: TabId, query: string, includeTools?: boolean): ConvoSearchResult => {
      const sessionId = status.snapshot(tabId)?.sessionId
      if (!sessionId) return { hits: [], total: 0, searched: 0, found: false }
      return searchConversation(sessionId, query, includeTools)
    }
  )

  // Rate-limit burn forecast, from the shared sample store (see createServices).
  ipcMain.handle('rate:forecast', () => services.rate.forecast())

  ipcMain.handle('branches:recent', () => services.branches.recent())

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

  // Both file windows reach the tab's cwd plus its added directories — always
  // resolved here from the tab's own state, never passed in by a renderer.
  const rootsFor = (tabId: TabId): { cwd: string | null; addedDirs: string[] } => {
    const cwd = status.getCwd(tabId)
    return { cwd, addedDirs: cwd ? mergeAddedDirs(cwd, status.getAddedDirs(tabId)) : [] }
  }
  // What the file window may reach: the tab's roots, plus the pattern list it
  // edits (which lives in userData, outside every project).
  const patternsFile = join(app.getPath('userData'), 'config-file-patterns.json')
  const docRoots = (tabId: TabId): string[] => {
    const { cwd, addedDirs } = rootsFor(tabId)
    return cwd ? [cwd, ...addedDirs, patternsFile] : []
  }

  ipcMain.handle('docs:list', (_e, tabId: TabId) => {
    const { cwd, addedDirs } = rootsFor(tabId)
    if (!cwd) {
      return { plans: [], roadmap: null, sections: [], roots: [], config: [], patternsFile }
    }
    const config = listConfigFiles(cwd, addedDirs, patternsFile)
    return { ...listProjectDocs(cwd, addedDirs), config: config.sections, patternsFile }
  })
  ipcMain.handle('docs:tree', (_e, tabId: TabId, dir: string) => {
    return listTree(docRoots(tabId), dir)
  })
  // the filter box searches the whole project, not just what the rail lists —
  // a file with no extension is in neither markdown nor settings group
  ipcMain.handle('docs:find', (_e, tabId: TabId, query: string) => {
    const { cwd, addedDirs } = rootsFor(tabId)
    return cwd ? findFiles([cwd, ...addedDirs], query) : []
  })
  // The app's own settings for the tab's project, kept with the project.
  ipcMain.handle('project:settings', (_e, tabId: TabId): ProjectSettings => {
    const { cwd } = rootsFor(tabId)
    return cwd ? readProjectSettings(cwd) : {}
  })
  ipcMain.handle(
    'project:setSettings',
    (_e, tabId: TabId, patch: ProjectSettingsPatch): boolean => {
      const { cwd } = rootsFor(tabId)
      return cwd ? writeProjectSettings(cwd, patch) : false
    }
  )

  // The diff window's two reads: what changed, and a file's committed side.
  ipcMain.handle('git:changes', async (_e, tabId: TabId): Promise<ProjectChanges> => {
    const { cwd } = rootsFor(tabId)
    if (!cwd) return { files: [], turnFiles: [], turnStartedAt: null, inRepo: false }
    return projectChanges(cwd, status.snapshot(tabId)?.sessionId ?? null)
  })
  ipcMain.handle('git:fileAtHead', async (_e, tabId: TabId, path: string) => {
    const { cwd, addedDirs } = rootsFor(tabId)
    if (!cwd || !insideAny([cwd, ...addedDirs], path)) return null
    return fileAtHead(cwd, path)
  })

  /**
   * Undo the current turn: put the checkpoint's version of the files it wrote
   * back. Only those files — anything else that changed since is the user's own
   * work. The renderer confirms first; this is the point of no return.
   */
  ipcMain.handle('git:revertTurn', async (_e, tabId: TabId): Promise<RevertResult | null> => {
    const { cwd } = rootsFor(tabId)
    const cp = checkpoints.latest(tabId)
    if (!cwd || !cp) return null
    const changes = await projectChanges(cwd, status.snapshot(tabId)?.sessionId ?? null)
    if (!changes.turnFiles.length) return { at: cp.at, steps: [] }
    return revertFiles(cp, changes.turnFiles)
  })

  // A `src/main/ipc.ts:403` the terminal printed. The raw text is resolved here
  // rather than in the renderer: only main knows the tab's roots, and terminal
  // output is not a trusted source of paths.
  ipcMain.handle('file:openLink', (_e, tabId: TabId, raw: string): boolean => {
    const link = parseFileLink(raw)
    const { cwd, addedDirs } = rootsFor(tabId)
    if (!link || !cwd) return false
    const hit = resolveFileLink([cwd, ...addedDirs], link)
    if (!hit) return false
    // the window titles itself "File editor — <file> — <owner>", so the owner
    // half is the project, exactly as it is when a tab opens the window
    openOrFocusDocsWindow(tabId, 'docs', basename(cwd), { ...hit, edit: true })
    return true
  })

  ipcMain.handle('docs:read', (_e, tabId: TabId, path: string, allowOversize?: boolean) => {
    return readDoc(docRoots(tabId), path, allowOversize)
  })
  ipcMain.handle('docs:open', (_e, tabId: TabId, path: string) => {
    return openDoc(docRoots(tabId), path)
  })
  ipcMain.handle('docs:reveal', (_e, tabId: TabId, path: string) => {
    return revealDoc(docRoots(tabId), path)
  })
  ipcMain.handle('docs:write', (_e, tabId: TabId, path: string, content: string) => {
    return writeDoc(docRoots(tabId), path, content)
  })
  /**
   * Create one file, asking first when it needs folders that don't exist yet —
   * `/add-file research/2026/notes.md` is allowed to make the whole path, but
   * never silently. Null means the user said no; the caller leaves it at that.
   */
  const createWithFolders = async (
    sender: Electron.WebContents,
    tabId: TabId,
    wanted: string
  ): Promise<CreateDocResult | null> => {
    const { cwd, addedDirs } = rootsFor(tabId)
    if (!cwd) return { ok: false, error: 'No working directory for this tab' }
    const planned = planNewFile(cwd, wanted, addedDirs)
    if (!planned.ok) return planned
    const { path, missingDirs } = planned.plan
    if (missingDirs.length) {
      const win = BrowserWindow.fromWebContents(sender)
      const many = missingDirs.length > 1
      const question = {
        type: 'question' as const,
        buttons: [many ? 'Create folders' : 'Create folder', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Create ${many ? 'folders' : 'the folder'} ${missingDirs.map((d) => `“${d}”`).join(', ')}?`,
        detail: `${basename(path)} goes in a folder that doesn't exist yet.`
      }
      const answer = win
        ? await dialog.showMessageBox(win, question)
        : await dialog.showMessageBox(question)
      if (answer.response !== 0) return null
    }
    return createDoc(cwd, path, addedDirs)
  }

  ipcMain.handle('docs:create', (e, tabId: TabId, path: string) =>
    createWithFolders(e.sender, tabId, path)
  )
  // "New file" in the file window: the OS save dialog picks the folder and the
  // name, we create it. Null means the user cancelled — not an error to report.
  ipcMain.handle(
    'docs:newFile',
    async (e, tabId: TabId, near?: string): Promise<CreateDocResult | null> => {
      const { cwd, addedDirs } = rootsFor(tabId)
      if (!cwd) return { ok: false, error: 'No working directory for this tab' }
      const options = {
        title: 'New file',
        buttonLabel: 'Create',
        defaultPath: newFileStartPath(cwd, addedDirs, near),
        properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const]
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      const picked = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return null
      return createWithFolders(e.sender, tabId, picked.filePath)
    }
  )

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

  ipcMain.handle('completions:npmScripts', (_e, tabId: TabId, query: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? listNpmScripts(cwd, query) : []
  })

  ipcMain.handle('git:switch', (_e, tabId: TabId, branch: string, root?: string) => {
    // `root` targets one of the tab's OTHER workspace repos (branch menu);
    // only folders the status bar actually points at are allowed
    if (root && !isWorkspaceRoot(status.snapshot(tabId), root)) {
      return { ok: false, error: 'not a workspace folder of this tab' }
    }
    const dir = root ?? status.getCwd(tabId)
    return dir ? switchBranch(dir, branch) : { ok: false, error: 'no working directory' }
  })

  ipcMain.handle('branches:workspace', (_e, tabId: TabId) =>
    workspaceBranchGroups(status.snapshot(tabId), listBranchRefs)
  )

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
