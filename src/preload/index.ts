import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CompanionInfo,
  PairingInfo,
  ActivityReport,
  BookedWorklog,
  BookResult,
  BranchGroup,
  BranchHistoryEntry,
  BranchSwitchResult,
  ConvoSearchResult,
  CreateDocResult,
  DocGroup,
  DocTarget,
  HelpSection,
  JiraStatus,
  LoggedWorklog,
  NpmScript,
  PersistedSession,
  PrGroup,
  PrInfo,
  ProjectChanges,
  ProjectDocs,
  ProjectSettings,
  ProjectSettingsPatch,
  RateForecast,
  RevertResult,
  SlashCommand,
  TabId,
  TreeNode,
  TabInfo,
  TabStatus,
  VolumeOp,
  VolumeState,
  WorklogPlan,
  WorklogPlanEntry
} from '../shared/types'
import type { FolderChip } from '../shared/status-folders'

export interface ClaudeTermApi {
  /** the OS this is running on ('darwin', 'win32', 'linux') — for wording that
   *  has to name the file manager */
  platform: string
  initialCwd(): Promise<string | null>
  createTab(
    cwd?: string,
    resume?: string,
    addedDirs?: string[],
    removedDirs?: string[]
  ): Promise<TabInfo>
  closeTab(tabId: TabId): Promise<void>
  restartTab(tabId: TabId): Promise<void>
  pickFolder(): Promise<string | null>
  openExternal(url: string): Promise<void>
  /** reveal a folder in Finder */
  openFolder(dir: string): Promise<void>
  /** native right-click menu for a folder chip (WebStorm / VS Code / Finder / iTerm2 / new tab) */
  folderContextMenu(dir: string, tabId?: TabId): void
  /** extra folders of a tab — `/add-dir`'d or settings-sourced, removable */
  extraDirs(tabId: TabId): Promise<FolderChip[]>
  /** drop one extra folder (a path, or the name as shown) from a tab */
  removeDir(
    tabId: TabId,
    dir: string
  ): Promise<{ ok: true; dir: string } | { ok: false; error: string }>
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
  /** ⌘F over the tab session's own conversation; `includeTools` widens the
   *  search to tool calls, their output and thinking */
  searchConversation(
    tabId: TabId,
    query: string,
    includeTools?: boolean
  ): Promise<ConvoSearchResult>
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
  onScreenRequest(cb: (requestId: string, tabId: TabId) => void): () => void
  screenReply(requestId: string, rows: string[]): void
  companionOffer(): Promise<PairingInfo>
  companionCancelOffer(): Promise<void>
  companionDevices(): Promise<CompanionInfo>
  companionRevoke(deviceId: string): Promise<boolean>
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
  /** run `git switch <branch>` in the tab's cwd, or in one of the tab's other
   *  workspace repos when `root` is given (status-bar branch menu) */
  switchBranch(tabId: TabId, branch: string, root?: string): Promise<BranchSwitchResult>
  /** local branches of every workspace repo, grouped by folder (branch menu) */
  listWorkspaceBranches(tabId: TabId): Promise<BranchGroup[]>
  listDocs(tabId: TabId): Promise<ProjectDocs>
  /** one level of a folder in the docs window's file tree */
  listDocTree(tabId: TabId, dir: string): Promise<TreeNode[]>
  /** files anywhere under the window's roots matching the filter box (plain
   *  text matches anywhere; `*` and `?` make it a pattern) */
  findDocFiles(tabId: TabId, query: string): Promise<TreeNode[]>
  /** a file's text; `allowOversize` answers the size warning ("Open anyway") */
  readDoc(tabId: TabId, path: string, allowOversize?: boolean): Promise<string | null>
  openDoc(tabId: TabId, path: string): Promise<boolean>
  /** show the file in Finder / Explorer, selected in its folder */
  revealDoc(tabId: TabId, path: string): Promise<boolean>
  writeDoc(tabId: TabId, path: string, content: string): Promise<boolean>
  /** create a file under the tab's cwd (for /add-file), asking first when the
   *  path needs folders that don't exist. Null when that question was declined */
  createDoc(tabId: TabId, path: string): Promise<CreateDocResult | null>
  /** (file window) pick a folder + name in the OS save dialog and create that
   *  file; `near` is where to open the picker. Null when the user cancelled */
  newDocFile(tabId: TabId, near?: string): Promise<CreateDocResult | null>
  /** open (or focus, if already open) the docs window for a tab, on `group` —
   *  `target` selects one specific file instead of the group's first */
  openDocsWindow(tabId: TabId, group: DocGroup, title: string, target?: DocTarget): void
  /** open a `path:line` the terminal printed, in the file window at that line.
   *  False when it resolves to nothing inside the tab's roots */
  openFileLink(tabId: TabId, raw: string): Promise<boolean>
  /** this project's own claude-term settings (.claude/claude-term-settings.local.json) */
  projectSettings(tabId: TabId): Promise<ProjectSettings>
  /** merge a change into them; a null value removes that key. False when the
   *  file is there but unparsable — it is not ours to overwrite blindly */
  setProjectSettings(tabId: TabId, patch: ProjectSettingsPatch): Promise<boolean>
  /** everything that differs from HEAD, with the current turn's files marked */
  gitChanges(tabId: TabId): Promise<ProjectChanges>
  /** a file's committed text — the left side of the diff. Null when HEAD has
   *  no such file (just added) or it is too big to show */
  gitFileAtHead(tabId: TabId, path: string): Promise<string | null>
  /** undo the current turn: put back the checkpoint taken when it started, for
   *  the files it wrote and nothing else. Null when there is no checkpoint
   *  (no repository, or no turn has started since the app did) */
  /** undo the last `depth` turns (1 = the turn that just ran) */
  revertTurn(tabId: TabId, depth?: number): Promise<RevertResult | null>
  /** (docs window only) the owner tab asked to switch section / retitle */
  onDocsSetGroup(
    cb: (payload: { group: DocGroup; title: string; target?: DocTarget }) => void
  ): () => void
  /** (docs window only) report unsaved-edit state so close can prompt to save */
  docsDirty(dirty: boolean): void
  /** (docs window only) main asks the window to save before closing */
  onDocsRequestSave(cb: () => void): () => void
  /** (docs window only) acknowledge a save request has completed */
  docsSaveDone(): void
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
  platform: process.platform,
  initialCwd: () => ipcRenderer.invoke('app:initialCwd'),
  createTab: (cwd, resume, addedDirs, removedDirs) =>
    ipcRenderer.invoke('tab:create', cwd, resume, addedDirs, removedDirs),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  restartTab: (tabId) => ipcRenderer.invoke('tab:restart', tabId),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', dir),
  folderContextMenu: (dir, tabId) => ipcRenderer.send('folder:contextMenu', dir, tabId),
  extraDirs: (tabId) => ipcRenderer.invoke('dirs:extra', tabId),
  removeDir: (tabId, dir) => ipcRenderer.invoke('dirs:remove', tabId, dir),
  onOpenFolderTab: (cb) => subscribe('folder:openTab', cb),
  listPrs: (tabId) => ipcRenderer.invoke('prs:list', tabId),
  onShowHelp: (cb) => subscribe('help:show', cb),
  prContextMenu: (tabId, pr, root) => ipcRenderer.send('prs:contextMenu', tabId, pr, root),
  statusSnapshot: (tabId) => ipcRenderer.invoke('status:snapshot', tabId),
  missionDoing: (tabId) => ipcRenderer.invoke('mission:doing', tabId),
  searchConversation: (tabId, query, includeTools) =>
    ipcRenderer.invoke('convo:search', tabId, query, includeTools),
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
  onScreenRequest: (cb) => subscribe('screen:request', cb),
  screenReply: (requestId: string, rows: string[]) =>
    ipcRenderer.send('screen:reply', requestId, rows),
  companionOffer: () => ipcRenderer.invoke('companion:offer'),
  companionCancelOffer: () => ipcRenderer.invoke('companion:cancelOffer'),
  companionDevices: () => ipcRenderer.invoke('companion:devices'),
  companionRevoke: (deviceId: string) => ipcRenderer.invoke('companion:revoke', deviceId),
  volumeGet: () => ipcRenderer.invoke('volume:get'),
  volumeSet: (op) => ipcRenderer.invoke('volume:set', op),
  grammarWasm: () => ipcRenderer.invoke('grammar:wasm'),
  listCommands: (tabId) => ipcRenderer.invoke('completions:commands', tabId),
  searchFiles: (tabId, query) => ipcRenderer.invoke('completions:files', tabId, query),
  listBranches: (tabId, query) => ipcRenderer.invoke('completions:branches', tabId, query),
  listDirs: (tabId, query) => ipcRenderer.invoke('completions:dirs', tabId, query),
  listNpmScripts: (tabId, query) => ipcRenderer.invoke('completions:npmScripts', tabId, query),
  switchBranch: (tabId, branch, root) => ipcRenderer.invoke('git:switch', tabId, branch, root),
  listWorkspaceBranches: (tabId) => ipcRenderer.invoke('branches:workspace', tabId),
  listDocs: (tabId) => ipcRenderer.invoke('docs:list', tabId),
  listDocTree: (tabId, dir) => ipcRenderer.invoke('docs:tree', tabId, dir),
  findDocFiles: (tabId, query) => ipcRenderer.invoke('docs:find', tabId, query),
  readDoc: (tabId, path, allowOversize) =>
    ipcRenderer.invoke('docs:read', tabId, path, allowOversize),
  openDoc: (tabId, path) => ipcRenderer.invoke('docs:open', tabId, path),
  revealDoc: (tabId, path) => ipcRenderer.invoke('docs:reveal', tabId, path),
  writeDoc: (tabId, path, content) => ipcRenderer.invoke('docs:write', tabId, path, content),
  createDoc: (tabId, path) => ipcRenderer.invoke('docs:create', tabId, path),
  newDocFile: (tabId, near) => ipcRenderer.invoke('docs:newFile', tabId, near),
  openDocsWindow: (tabId, group, title, target) =>
    ipcRenderer.send('docs:openWindow', tabId, group, title, target),
  openFileLink: (tabId, raw) => ipcRenderer.invoke('file:openLink', tabId, raw),
  projectSettings: (tabId) => ipcRenderer.invoke('project:settings', tabId),
  setProjectSettings: (tabId, patch) => ipcRenderer.invoke('project:setSettings', tabId, patch),
  gitChanges: (tabId) => ipcRenderer.invoke('git:changes', tabId),
  gitFileAtHead: (tabId, path) => ipcRenderer.invoke('git:fileAtHead', tabId, path),
  revertTurn: (tabId, depth) => ipcRenderer.invoke('git:revertTurn', tabId, depth),
  onDocsSetGroup: (cb) => subscribe('docs:setGroup', cb),
  docsDirty: (dirty) => ipcRenderer.send('docs:dirty', dirty),
  onDocsRequestSave: (cb) => subscribe('docs:requestSave', cb),
  docsSaveDone: () => ipcRenderer.send('docs:saveDone'),
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
