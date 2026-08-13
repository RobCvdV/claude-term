import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { TabId } from '../shared/types'

/**
 * Detached editor windows, one per tab and one set per kind (docs, settings).
 * Each is a normal top-level window (its own controls) but its lifetime is
 * bound to the tab it was opened from: closing the tab closes it, re-opening
 * focuses the existing one rather than spawning a second, and unsaved editor
 * changes are prompted for before either can close.
 *
 * The two kinds differ only in their size, their query string and how an
 * already-open window is re-pointed — everything else (the per-tab map, dirty
 * tracking, the save-before-close handshake) is this module's job.
 */

/** What one kind of window needs to say about itself. */
export interface FileWindowSpec<Open> {
  /** IPC channel prefix; owns `<channel>:dirty`, `:requestSave`, `:saveDone` */
  channel: string
  width: number
  height: number
  /** what the unsaved-changes prompt calls the open file ("document", "file") */
  subject: string
  /** the window's own OS title, when it differs from what the renderer is told
   *  (the renderer refines it once loaded — this is what shows until then) */
  osTitle?: (title: string) => string
  /** query string, leading `?` included, for a freshly opened window */
  query: (tabId: TabId, title: string, open: Open) => string
  /** re-point a window that is already open (it keeps its renderer) */
  retarget: (win: BrowserWindow, title: string, open: Open) => void
}

export interface FileWindows<Open> {
  /** Open this kind of window for a tab, or focus + retarget it if already open. */
  openOrFocus: (tabId: TabId, title: string, open: Open) => void
  /** Close the window bound to a tab (the tab itself is closing). Prompts to
   *  save/discard first — the save must run before the caller tears down the
   *  tab's status entry, or the file's roots can no longer resolve. */
  closeForTab: (tabId: TabId) => Promise<void>
  /** Tear down every window of this kind (main window closed — app quitting). */
  closeAll: () => void
}

interface Entry {
  win: BrowserWindow
  /** last dirty state reported by the renderer (unsaved editor changes) */
  dirty: boolean
  /** set once the close has been confirmed so the guard lets it through */
  forceClose: boolean
}

/** How long a wedged renderer may hold up a close before we give up on its save. */
const SAVE_TIMEOUT_MS = 5000

export function createFileWindows<Open>(spec: FileWindowSpec<Open>): FileWindows<Open> {
  const windows = new Map<TabId, Entry>()

  const entryForSender = (wc: Electron.WebContents): Entry | undefined => {
    for (const e of windows.values()) if (e.win.webContents === wc) return e
    return undefined
  }

  let ipcReady = false
  const ensureIpc = (): void => {
    if (ipcReady) return
    ipcReady = true
    ipcMain.on(`${spec.channel}:dirty`, (e, dirty: boolean) => {
      const entry = entryForSender(e.sender)
      if (entry) entry.dirty = dirty
    })
  }

  /** Ask the renderer to save, resolving once it confirms (or after a short
   *  timeout, so a wedged renderer can't block the close forever). */
  const requestSave = (win: BrowserWindow): Promise<void> =>
    new Promise((resolve) => {
      const channel = `${spec.channel}:saveDone`
      const done = (e: Electron.IpcMainEvent): void => {
        if (e.sender !== win.webContents) return
        clearTimeout(timer)
        ipcMain.removeListener(channel, done)
        resolve()
      }
      const timer = setTimeout(() => {
        ipcMain.removeListener(channel, done)
        resolve()
      }, SAVE_TIMEOUT_MS)
      ipcMain.on(channel, done)
      win.webContents.send(`${spec.channel}:requestSave`)
    })

  /** Prompt for unsaved changes. Returns true if the close should proceed.
   *  `allowCancel` offers a third "keep editing" button (user-initiated close);
   *  without it there are only Save / Discard (the tab is closing regardless). */
  const confirmClose = async (entry: Entry, allowCancel: boolean): Promise<boolean> => {
    if (!entry.dirty) return true
    const buttons = allowCancel ? ['Save', "Don't Save", 'Cancel'] : ['Save', 'Discard']
    const { response } = await dialog.showMessageBox(entry.win, {
      type: 'warning',
      buttons,
      defaultId: 0,
      // Esc / dismiss maps here: Cancel when offered, else Save (never lose edits)
      cancelId: allowCancel ? 2 : 0,
      message: `Save changes to this ${spec.subject}?`,
      detail: "Your changes will be lost if you don't save them."
    })
    if (allowCancel && response === 2) return false
    if (response === 0) await requestSave(entry.win)
    return true
  }

  const openOrFocus = (tabId: TabId, title: string, open: Open): void => {
    ensureIpc()
    const existing = windows.get(tabId)
    if (existing && !existing.win.isDestroyed()) {
      if (existing.win.isMinimized()) existing.win.restore()
      existing.win.show()
      existing.win.focus()
      spec.retarget(existing.win, title, open)
      return
    }

    const win = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      show: false,
      title: spec.osTitle?.(title) ?? title,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true
      }
    })
    const entry: Entry = { win, dirty: false, forceClose: false }
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

    const query = spec.query(tabId, title, open)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + query)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
    }
  }

  const closeForTab = async (tabId: TabId): Promise<void> => {
    const entry = windows.get(tabId)
    if (!entry || entry.win.isDestroyed()) return
    await confirmClose(entry, false)
    entry.forceClose = true
    if (!entry.win.isDestroyed()) entry.win.destroy()
  }

  const closeAll = (): void => {
    for (const entry of windows.values()) {
      entry.forceClose = true
      if (!entry.win.isDestroyed()) entry.win.destroy()
    }
    windows.clear()
  }

  return { openOrFocus, closeForTab, closeAll }
}
