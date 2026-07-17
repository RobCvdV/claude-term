import { contextBridge, ipcRenderer } from 'electron'
import type { SlashCommand, TabId, TabInfo, TabStatus } from '../shared/types'

export interface ClaudeTermApi {
  initialCwd(): Promise<string | null>
  createTab(cwd: string): Promise<TabInfo>
  closeTab(tabId: TabId): Promise<void>
  restartTab(tabId: TabId, resume: boolean): Promise<void>
  pickFolder(): Promise<string | null>
  statusSnapshot(tabId: TabId): Promise<TabStatus | null>
  listCommands(tabId: TabId): Promise<SlashCommand[]>
  searchFiles(tabId: TabId, query: string): Promise<string[]>
  ptyInput(tabId: TabId, data: string): void
  ptyResize(tabId: TabId, cols: number, rows: number): void
  submitPrompt(tabId: TabId, text: string): void
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
  createTab: (cwd) => ipcRenderer.invoke('tab:create', cwd),
  closeTab: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  restartTab: (tabId, resume) => ipcRenderer.invoke('tab:restart', tabId, resume),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  statusSnapshot: (tabId) => ipcRenderer.invoke('status:snapshot', tabId),
  listCommands: (tabId) => ipcRenderer.invoke('completions:commands', tabId),
  searchFiles: (tabId, query) => ipcRenderer.invoke('completions:files', tabId, query),
  ptyInput: (tabId, data) => ipcRenderer.send('pty:input', tabId, data),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', tabId, cols, rows),
  submitPrompt: (tabId, text) => ipcRenderer.send('prompt:submit', tabId, text),
  onPtyData: (cb) => subscribe('pty:data', cb),
  onPtyExit: (cb) => subscribe('pty:exit', cb),
  onStatusUpdate: (cb) => subscribe('status:update', cb),
  onAttention: (cb) => subscribe('tab:attention', cb)
}

contextBridge.exposeInMainWorld('claudeTerm', api)
