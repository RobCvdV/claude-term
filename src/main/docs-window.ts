import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { DocGroup, TabId } from '../shared/types'

/**
 * Docs viewer/editor windows, one per tab. Each is a normal top-level window
 * (its own controls) but its lifetime is bound to the tab it was opened from:
 * closing the tab closes it, and re-opening focuses the existing one rather
 * than spawning a second.
 */
const windows = new Map<TabId, BrowserWindow>()

/** Open the docs window for a tab, or focus + retarget it if already open. */
export function openOrFocusDocsWindow(tabId: TabId, group: DocGroup, title: string): void {
  const existing = windows.get(tabId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    existing.webContents.send('docs:setGroup', { group, title })
    return
  }

  const win = new BrowserWindow({
    width: 900,
    height: 720,
    show: false,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  windows.set(tabId, win)

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => windows.delete(tabId))
  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const query =
    `?docs=1&tabId=${encodeURIComponent(tabId)}` +
    `&group=${group}&title=${encodeURIComponent(title)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + query)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }
}

/** Close the docs window bound to a tab (called when the tab itself closes). */
export function closeDocsWindowForTab(tabId: TabId): void {
  const win = windows.get(tabId)
  if (win && !win.isDestroyed()) win.close()
  windows.delete(tabId)
}

/** Tear down every docs window (called when the main window closes). */
export function closeAllDocsWindows(): void {
  for (const win of windows.values()) if (!win.isDestroyed()) win.destroy()
  windows.clear()
}
