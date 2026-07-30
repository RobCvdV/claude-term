import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { TabId } from '../shared/types'

/**
 * Settings windows (project configuration files), one per tab — the same shape
 * as the docs window: a normal top-level window whose lifetime is bound to the
 * tab it was opened from, so closing the tab closes it and re-opening focuses
 * the existing one instead of spawning a second.
 */
interface ConfigWin {
  win: BrowserWindow
  /** last dirty state reported by the renderer (unsaved editor changes) */
  dirty: boolean
  /** set once the close has been confirmed so the guard lets it through */
  forceClose: boolean
}

const windows = new Map<TabId, ConfigWin>()

function entryForSender(wc: Electron.WebContents): ConfigWin | undefined {
  for (const e of windows.values()) if (e.win.webContents === wc) return e
  return undefined
}

let ipcReady = false
function ensureIpc(): void {
  if (ipcReady) return
  ipcReady = true
  ipcMain.on('config:dirty', (e, dirty: boolean) => {
    const entry = entryForSender(e.sender)
    if (entry) entry.dirty = dirty
  })
}

/** Ask the renderer to save, resolving once it confirms (or after a short
 *  timeout, so a wedged renderer can't block the close forever). */
function requestSave(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    const done = (e: Electron.IpcMainEvent): void => {
      if (e.sender !== win.webContents) return
      clearTimeout(timer)
      ipcMain.removeListener('config:saveDone', done)
      resolve()
    }
    const timer = setTimeout(() => {
      ipcMain.removeListener('config:saveDone', done)
      resolve()
    }, 5000)
    ipcMain.on('config:saveDone', done)
    win.webContents.send('config:requestSave')
  })
}

/** Prompt for unsaved changes. Returns true if the close should proceed.
 *  `allowCancel` offers a third "keep editing" button (user-initiated close);
 *  without it there are only Save / Discard (the tab is closing regardless). */
async function confirmClose(entry: ConfigWin, allowCancel: boolean): Promise<boolean> {
  if (!entry.dirty) return true
  const buttons = allowCancel ? ['Save', "Don't Save", 'Cancel'] : ['Save', 'Discard']
  const { response } = await dialog.showMessageBox(entry.win, {
    type: 'warning',
    buttons,
    defaultId: 0,
    // Esc / dismiss maps here: Cancel when offered, else Save (never lose edits)
    cancelId: allowCancel ? 2 : 0,
    message: 'Save changes to this file?',
    detail: "Your changes will be lost if you don't save them."
  })
  if (allowCancel && response === 2) return false
  if (response === 0) await requestSave(entry.win)
  return true
}

/** Open the settings window for a tab, or focus it if it is already open. */
export function openOrFocusConfigWindow(tabId: TabId, title: string): void {
  ensureIpc()
  const existing = windows.get(tabId)
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore()
    existing.win.show()
    existing.win.focus()
    existing.win.setTitle(title)
    // the roots may have changed since it was opened (a new /add-dir)
    existing.win.webContents.send('config:refresh')
    return
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  const entry: ConfigWin = { win, dirty: false, forceClose: false }
  windows.set(tabId, entry)

  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (entry.forceClose || !entry.dirty) return
    e.preventDefault()
    void confirmClose(entry, true).then((ok) => {
      if (!ok) return
      entry.forceClose = true
      if (!win.isDestroyed()) win.destroy()
    })
  })
  win.on('closed', () => windows.delete(tabId))
  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const query =
    `?config=1&tabId=${encodeURIComponent(tabId)}` + `&title=${encodeURIComponent(title)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + query)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }
}

/** Close the settings window bound to a tab (the tab itself is closing).
 *  Prompts to save/discard first — the save must run before the caller tears
 *  down the tab's status entry, or the file's roots can no longer resolve. */
export async function closeConfigWindowForTab(tabId: TabId): Promise<void> {
  const entry = windows.get(tabId)
  if (!entry || entry.win.isDestroyed()) return
  await confirmClose(entry, false)
  entry.forceClose = true
  if (!entry.win.isDestroyed()) entry.win.destroy()
}

/** Tear down every settings window (main window closed — the app is quitting). */
export function closeAllConfigWindows(): void {
  for (const entry of windows.values()) {
    entry.forceClose = true
    if (!entry.win.isDestroyed()) entry.win.destroy()
  }
  windows.clear()
}
