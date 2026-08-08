import { BrowserWindow, Menu, shell } from 'electron'
import { execFile } from 'child_process'

const openInApp = (appName: string, dir: string): void => {
  execFile('open', ['-a', appName, dir], (err) => {
    // app not installed — at least reveal the folder
    if (err) void shell.openPath(dir)
  })
}

/** AppleScript string literal (escapes backslashes and quotes) */
const asStr = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`

// `open` always starts a new iTerm2 window, so drive it via AppleScript to get
// a tab in the current window instead. Addressed by bundle id — the .app may
// be renamed (e.g. "iTerm 2.app"), which breaks by-name resolution.
const ITERM_ID = 'com.googlecode.iterm2'
const openInITerm = (dir: string): void => {
  const script = `
    tell application id "${ITERM_ID}"
      activate
      if (count of windows) = 0 then
        create window with default profile
      else
        tell current window to create tab with default profile
      end if
      tell current session of current window to write text "cd " & quoted form of ${asStr(dir)}
    end tell`
  execFile('osascript', ['-e', script], (err) => {
    if (err) execFile('open', ['-b', ITERM_ID, dir])
  })
}

/** Right-click menu for a folder chip in the status bar. */
export function showFolderContextMenu(win: BrowserWindow, dir: string): void {
  const menu = Menu.buildFromTemplate([
    { label: 'Open in WebStorm…', click: () => openInApp('WebStorm', dir) },
    { label: 'Open in VS Code…', click: () => openInApp('Visual Studio Code', dir) },
    { label: 'Open in Finder…', click: () => void shell.openPath(dir) },
    { type: 'separator' },
    { label: 'Open in iTerm2…', click: () => openInITerm(dir) },
    { label: 'Open in New Tab…', click: () => win.webContents.send('folder:openTab', dir) }
  ])
  menu.popup({ window: win })
}
