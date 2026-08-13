import type { TabId } from '../shared/types'
import { createFileWindows } from './file-window'

const windows = createFileWindows<void>({
  channel: 'config',
  width: 1000,
  height: 760,
  subject: 'file',
  query: (tabId, title) =>
    `?config=1&tabId=${encodeURIComponent(tabId)}` + `&title=${encodeURIComponent(title)}`,
  retarget: (win, title) => {
    win.setTitle(title)
    // the roots may have changed since it was opened (a new /add-dir)
    win.webContents.send('config:refresh')
  }
})

/** Open the settings window for a tab, or focus it if it is already open. */
export function openOrFocusConfigWindow(tabId: TabId, title: string): void {
  windows.openOrFocus(tabId, title, undefined)
}

export const closeConfigWindowForTab = windows.closeForTab
export const closeAllConfigWindows = windows.closeAll
