import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ActivityReport,
  BookedWorklog,
  BookResult,
  BranchHistoryEntry,
  BranchSwitchResult,
  DocGroup,
  HelpSection,
  JiraStatus,
  LoggedWorklog,
  NpmScript,
  PersistedSession,
  PrGroup,
  PrInfo,
  ProjectConfigFiles,
  ProjectDocs,
  RateForecast,
  SlashCommand,
  TabId,
  TabInfo,
  TabStatus,
  VolumeOp,
  VolumeState,
  WorklogPlan,
  WorklogPlanEntry
} from '../shared/types'

export interface ClaudeTermApi {
  initialCwd(): Promise<string | null>
  createTab(cwd?: string, resume?: string, addedDirs?: string[]): Promise<TabInfo>
  closeTab(tabId: TabId): Promise<void>
  restartTab(tabId: TabId): Promise<void>
  pickFolder(): Promise<string | null>
  openExternal(url: string): Promise<void>
  /** reveal a folder in Finder */
  openFolder(dir: string): Promise<void>
  /** native right-click menu for a folder chip (WebStorm / VS Code / Finder / iTerm2 / new tab) */
  folderContextMenu(dir: string): void
  /** "Open in New Tab…" was picked in the folder context menu */
  onOpenFolderTab(cb: (dir: string) => void): () => void
  /** open PRs of every workspace repo, grouped by folder (max 10 per repo) */
  listPrs(tabId: TabId): Promise<PrGroup[]>
  /** Help menu picked Quick How-To / User Guide — open the help overlay */
  onShowHelp(cb: (section: HelpSection) => void): () => void
  /** native right-click menu for a PR entry (Open / Merge where allowed);
   *  `root` is the workspace folder of the PR's repo group */
  prContextMenu(tabId: TabId, pr: PrInfo, root?: string): void
  statusSnapshot(tabId: TabId): Promise<TabStatus | null>
  /** one-line "doing" snippet for a tab's session (mission control) */
  missionDoing(tabId: TabId): Promise<string | null>
  /** projected time-to-100% of the 5h/7d rate-limit windows */
  rateForecast(): Promise<RateForecast>
  /** branches recently seen checked out in any tab, most recent first (⌘K) */
  recentBranches(): Promise<BranchHistoryEntry[]>
  activityReport(rangeDays: number): Promise<ActivityReport>
  saveWorklogPlan(plan: WorklogPlan): Promise<void>
  worklogLogged(): Promise<LoggedWorklog[]>
  jiraStatus(): Promise<JiraStatus>
  jiraConnect(email: string, token: string): Promise<{ ok: boolean; error?: string }>
  jiraDisconnect(): Promise<void>
  /** my Jira worklogs within the trailing window (needs a connected token) */
  jiraBooked(
    rangeDays: number
  ): Promise<{ ok: true; booked: BookedWorklog[] } | { ok: false; error: string }>
  /** post worklogs straight to Jira; per-entry results, failures don't abort */
  jiraBook(entries: WorklogPlanEntry[]): Promise<BookResult[]>
  volumeGet(): Promise<VolumeState>
  volumeSet(op: VolumeOp): Promise<VolumeState>
  /** Harper's wasm bytes for the grammar checker; null when not installed */
  grammarWasm(): Promise<Uint8Array | null>
  listCommands(tabId: TabId): Promise<SlashCommand[]>
  searchFiles(tabId: TabId, query: string): Promise<string[]>
  /** local git branches matching `query` (substring match), for /switch */
  listBranches(tabId: TabId, query: string): Promise<string[]>
  /** directories under cwd matching `query` (single level), for /add-dir */
  listDirs(tabId: TabId, query: string): Promise<string[]>
  /** package.json scripts (root + one level deep) matching `query`, for /npm */
  listNpmScripts(tabId: TabId, query: string): Promise<NpmScript[]>
  /** run `git switch <branch>` in the tab's cwd */
  switchBranch(tabId: TabId, branch: string): Promise<BranchSwitchResult>
  listDocs(tabId: TabId): Promise<ProjectDocs>
  readDoc(tabId: TabId, path: string): Promise<string | null>
  openDoc(tabId: TabId, path: string): Promise<boolean>
  writeDoc(tabId: TabId, path: string, content: string): Promise<boolean>
  /** open (or focus, if already open) the docs window for a tab, on `group` */
  openDocsWindow(tabId: TabId, group: DocGroup, title: string): void
  /** (docs window only) the owner tab asked to switch section / retitle */
  onDocsSetGroup(cb: (payload: { group: DocGroup; title: string }) => void): () => void
  /** (docs window only) report unsaved-edit state so close can prompt to save */
  docsDirty(dirty: boolean): void
  /** (docs window only) main asks the window to save before closing */
  onDocsRequestSave(cb: () => void): () => void
  /** (docs window only) acknowledge a save request has completed */
  docsSaveDone(): void
  listConfigFiles(tabId: TabId): Promise<ProjectConfigFiles>
  readConfigFile(tabId: TabId, path: string): Promise<string | null>
  writeConfigFile(tabId: TabId, path: string, content: string): Promise<boolean>
  /** open (or focus, if already open) the settings window for a tab */
  openConfigWindow(tabId: TabId, title: string): void
  /** (settings window only) the owner tab re-opened it — re-scan the roots */
  onConfigRefresh(cb: () => void): () => void
  /** (settings window only) report unsaved-edit state so close can prompt */
  configDirty(dirty: boolean): void
  /** (settings window only) main asks the window to save before closing */
  onConfigRequestSave(cb: () => void): () => void
  /** (settings window only) acknowledge a save request has completed */
  configSaveDone(): void
  loadSession(): Promise<PersistedSession | null>
  saveSession(state: PersistedSession): Promise<void>
  saveSessionSync(state: PersistedSession): void
  ptyInput(tabId: TabId, data: string): void
  pathForFile(file: File): string
  ptyResize(tabId: TabId, cols: number, rows: number): void
  submitPrompt(tabId: TabId, text: string, imageCount?: number): void
  onPtyData(cb: (tabId: TabId, data: string) => void): () => void
  onPtyExit(cb: (tabId: TabId, exitCode: number) => void): () => void
  onStatusUpdate(cb: (status: TabStatus) => void): () => void
  onAttention(cb: (tabId: TabId, hookEvent: string) => void): () => void
  /** the update that is downloaded and ready to install, or null when a newer
   *  release superseded it (re-fires with the newer one once that downloads) */
  onUpdateDownloaded(cb: (version: string | null) => void): () => void
  /** re-check the feed, then ask to restart & install; true if starting */
  installUpdate(): Promise<boolean>
}

function subscribe<Args extends unknown[]>(
  channel: string,
  cb: (...args: Args) => void
): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void =>
    cb(...(args as Args))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ClaudeTermApi = {
  initialCwd: () => ipcRenderer.invoke('app:initialCwd'),
  createTab: (cwd, resume, addedDirs) => ipcRenderer.invoke('tab:create', cwd, resume, addedDirs),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  restartTab: (tabId) => ipcRenderer.invoke('tab:restart', tabId),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  folderContextMenu: (dir) => ipcRenderer.send('folder:contextMenu', dir),
  onOpenFolderTab: (cb) => subscribe('folder:openTab', cb),
  listPrs: (tabId) => ipcRenderer.invoke('prs:list', tabId),
  onShowHelp: (cb) => subscribe('help:show', cb),
  prContextMenu: (tabId, pr, root) => ipcRenderer.send('prs:contextMenu', tabId, pr, root),
  statusSnapshot: (tabId) => ipcRenderer.invoke('status:snapshot', tabId),
  missionDoing: (tabId) => ipcRenderer.invoke('mission:doing', tabId),
  rateForecast: () => ipcRenderer.invoke('rate:forecast'),
  recentBranches: () => ipcRenderer.invoke('branches:recent'),
  activityReport: (rangeDays) => ipcRenderer.invoke('activity:report', rangeDays),
  saveWorklogPlan: (plan) => ipcRenderer.invoke('worklog:savePlan', plan),
  worklogLogged: () => ipcRenderer.invoke('worklog:logged'),
  jiraStatus: () => ipcRenderer.invoke('jira:status'),
  jiraConnect: (email, token) => ipcRenderer.invoke('jira:connect', email, token),
  jiraDisconnect: () => ipcRenderer.invoke('jira:disconnect'),
  jiraBooked: (rangeDays) => ipcRenderer.invoke('jira:booked', rangeDays),
  jiraBook: (entries) => ipcRenderer.invoke('jira:book', entries),
  volumeGet: () => ipcRenderer.invoke('volume:get'),
  volumeSet: (op) => ipcRenderer.invoke('volume:set', op),
  grammarWasm: () => ipcRenderer.invoke('grammar:wasm'),
  listCommands: (tabId) => ipcRenderer.invoke('completions:commands', tabId),
  searchFiles: (tabId, query) => ipcRenderer.invoke('completions:files', tabId, query),
  listBranches: (tabId, query) => ipcRenderer.invoke('completions:branches', tabId, query),
  listDirs: (tabId, query) => ipcRenderer.invoke('completions:dirs', tabId, query),
  listNpmScripts: (tabId, query) => ipcRenderer.invoke('completions:npmScripts', tabId, query),
  switchBranch: (tabId, branch) => ipcRenderer.invoke('git:switch', tabId, branch),
  listDocs: (tabId) => ipcRenderer.invoke('docs:list', tabId),
  readDoc: (tabId, path) => ipcRenderer.invoke('docs:read', tabId, path),
  openDoc: (tabId, path) => ipcRenderer.invoke('docs:open', tabId, path),
  writeDoc: (tabId, path, content) => ipcRenderer.invoke('docs:write', tabId, path, content),
  openDocsWindow: (tabId, group, title) => ipcRenderer.send('docs:openWindow', tabId, group, title),
  onDocsSetGroup: (cb) => subscribe('docs:setGroup', cb),
  docsDirty: (dirty) => ipcRenderer.send('docs:dirty', dirty),
  onDocsRequestSave: (cb) => subscribe('docs:requestSave', cb),
  docsSaveDone: () => ipcRenderer.send('docs:saveDone'),
  listConfigFiles: (tabId) => ipcRenderer.invoke('config:list', tabId),
  readConfigFile: (tabId, path) => ipcRenderer.invoke('config:read', tabId, path),
  writeConfigFile: (tabId, path, content) =>
    ipcRenderer.invoke('config:write', tabId, path, content),
  openConfigWindow: (tabId, title) => ipcRenderer.send('config:openWindow', tabId, title),
  onConfigRefresh: (cb) => subscribe('config:refresh', cb),
  configDirty: (dirty) => ipcRenderer.send('config:dirty', dirty),
  onConfigRequestSave: (cb) => subscribe('config:requestSave', cb),
  configSaveDone: () => ipcRenderer.send('config:saveDone'),
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (state) => ipcRenderer.invoke('session:save', state),
  saveSessionSync: (state) => ipcRenderer.sendSync('session:saveSync', state),
  ptyInput: (tabId, data) => ipcRenderer.send('pty:input', tabId, data),
  // sandboxed renderers can't see real filesystem paths on dropped File objects;
  // webUtils bridges that gap (File.path was removed in Electron 32)
  pathForFile: (file) => webUtils.getPathForFile(file),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', tabId, cols, rows),
  submitPrompt: (tabId, text, imageCount) =>
    ipcRenderer.send('prompt:submit', tabId, text, imageCount),
  onPtyData: (cb) => subscribe('pty:data', cb),
  onPtyExit: (cb) => subscribe('pty:exit', cb),
  onStatusUpdate: (cb) => subscribe('status:update', cb),
  onAttention: (cb) => subscribe('tab:attention', cb),
  onUpdateDownloaded: (cb) => subscribe('update:downloaded', cb),
  installUpdate: () => ipcRenderer.invoke('update:install')
}

contextBridge.exposeInMainWorld('claudeTerm', api)
