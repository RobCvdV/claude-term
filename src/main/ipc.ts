import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import type { TabId, TabInfo } from '../shared/types'
import { PtyManager } from './pty-manager'
import { StatusServer } from './status-server'
import { listCommands, searchFiles } from './completions'

export interface AppServices {
  ptys: PtyManager
  status: StatusServer
}

export function createServices(getWindow: () => BrowserWindow | null): AppServices {
  const status = new StatusServer()

  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const ptys = new PtyManager(
    () => ({ port: status.port, token: status.token }),
    {
      data: (tabId, data) => send('pty:data', tabId, data),
      exit: (tabId, exitCode) => {
        status.markExited(tabId, exitCode)
        send('pty:exit', tabId, exitCode)
      }
    }
  )

  status.onUpdate = (tabStatus) => send('status:update', tabStatus)
  status.onAttention = (tabId, hookEvent) => send('tab:attention', tabId, hookEvent)
  return { ptys, status }
}

export function registerIpc(services: AppServices, getWindow: () => BrowserWindow | null): void {
  const { ptys, status } = services

  ipcMain.handle('tab:create', async (_e, cwd?: string): Promise<TabInfo> => {
    const dir = cwd || homedir()
    const tabId: TabId = randomUUID()
    status.registerTab(tabId, dir)
    await ptys.create(tabId, dir)
    return { tabId, cwd: dir, title: basename(dir) || dir }
  })

  ipcMain.handle('tab:close', (_e, tabId: TabId) => {
    ptys.kill(tabId)
    status.removeTab(tabId)
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

  ipcMain.handle('status:snapshot', (_e, tabId: TabId) => status.snapshot(tabId))

  // dev/scripting convenience: auto-open a tab in this folder at startup
  ipcMain.handle('app:initialCwd', () => process.env.CLAUDE_TERM_DEFAULT_CWD ?? null)

  ipcMain.handle('completions:commands', (_e, tabId: TabId) => {
    const cwd = status.getCwd(tabId)
    return cwd ? listCommands(cwd) : []
  })

  ipcMain.handle('completions:files', (_e, tabId: TabId, query: string) => {
    const cwd = status.getCwd(tabId)
    return cwd ? searchFiles(cwd, query) : []
  })

  ipcMain.on('pty:input', (_e, tabId: TabId, data: string) => ptys.write(tabId, data))
  ipcMain.on('pty:resize', (_e, tabId: TabId, cols: number, rows: number) =>
    ptys.resize(tabId, cols, rows)
  )
  ipcMain.on('prompt:submit', (_e, tabId: TabId, text: string) => ptys.injectPrompt(tabId, text))
}
