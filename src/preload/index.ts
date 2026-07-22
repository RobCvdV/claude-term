import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ActivityReport,
  LoggedWorklog,
  PersistedSession,
  ProjectDocs,
  SlashCommand,
  TabId,
  TabInfo,
  TabStatus,
  VolumeOp,
  VolumeState,
  WorklogPlan
} from '../shared/types'

export interface ClaudeTermApi {
  initialCwd(): Promise<string | null>
  createTab(cwd?: string, resume?: string): Promise<TabInfo>
  closeTab(tabId: TabId): Promise<void>
  restartTab(tabId: TabId): Promise<void>
  pickFolder(): Promise<string | null>
  statusSnapshot(tabId: TabId): Promise<TabStatus | null>
  activityReport(rangeDays: number): Promise<ActivityReport>
  saveWorklogPlan(plan: WorklogPlan): Promise<void>
  worklogLogged(): Promise<LoggedWorklog[]>
  volumeGet(): Promise<VolumeState>
  volumeSet(op: VolumeOp): Promise<VolumeState>
  listCommands(tabId: TabId): Promise<SlashCommand[]>
  searchFiles(tabId: TabId, query: string): Promise<string[]>
  listDocs(tabId: TabId): Promise<ProjectDocs>
  readDoc(tabId: TabId, path: string): Promise<string | null>
  openDoc(tabId: TabId, path: string): Promise<boolean>
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
  createTab: (cwd, resume) => ipcRenderer.invoke('tab:create', cwd, resume),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  restartTab: (tabId) => ipcRenderer.invoke('tab:restart', tabId),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  statusSnapshot: (tabId) => ipcRenderer.invoke('status:snapshot', tabId),
  activityReport: (rangeDays) => ipcRenderer.invoke('activity:report', rangeDays),
  saveWorklogPlan: (plan) => ipcRenderer.invoke('worklog:savePlan', plan),
  worklogLogged: () => ipcRenderer.invoke('worklog:logged'),
  volumeGet: () => ipcRenderer.invoke('volume:get'),
  volumeSet: (op) => ipcRenderer.invoke('volume:set', op),
  listCommands: (tabId) => ipcRenderer.invoke('completions:commands', tabId),
  searchFiles: (tabId, query) => ipcRenderer.invoke('completions:files', tabId, query),
  listDocs: (tabId) => ipcRenderer.invoke('docs:list', tabId),
  readDoc: (tabId, path) => ipcRenderer.invoke('docs:read', tabId, path),
  openDoc: (tabId, path) => ipcRenderer.invoke('docs:open', tabId, path),
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
  onAttention: (cb) => subscribe('tab:attention', cb)
}

contextBridge.exposeInMainWorld('claudeTerm', api)
