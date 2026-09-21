import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { HelpSection } from '../shared/types'

const ZOOM_STEP = 0.5
/** Chromium only renders 25%–500%, and writes past that are kept, not clamped —
 *  so an unclamped step leaves a level no keypress can walk back from, and the
 *  other direction looks dead until it has been pressed its way back in. */
const ZOOM_MIN = -7.5
const ZOOM_MAX = 8.5

/**
 * macOS swallows the key for a menu item accelerated with `CommandOrControl+-`
 * or `+` and then never runs its click — Electron's own zoom roles have the
 * same hole. So those two items carry no accelerator and the keys are caught
 * here, ahead of the renderer. ⌘0 works as an accelerator and stays one.
 */
export function installZoomKeys(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return
    const step =
      input.key === '-' ? -ZOOM_STEP : input.key === '=' || input.key === '+' ? ZOOM_STEP : 0
    if (!step) return
    event.preventDefault()
    zoomBy(step)
  })
}

function zoomBy(step: number): void {
  // getFocusedWebContents() is what Electron's own zoom roles use; fall back to
  // the main window so the menu still works when focus sits on a chrome element
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  const { webContents } = win
  webContents.zoomLevel =
    step === 0 ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, webContents.zoomLevel + step))
}

/**
 * Install the application menu. This mirrors Electron's default menu (standard
 * Edit/Window roles, so clipboard, devtools etc. keep working) and adds a
 * "Check for Updates…" item — under the app menu on macOS, under Help
 * elsewhere — plus a Help menu opening the in-app Quick How-To / User Guide.
 */
export function installAppMenu(
  onCheckForUpdates: () => void,
  onShowHelp: (section: HelpSection) => void
): void {
  const isMac = process.platform === 'darwin'
  const checkForUpdates: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => onCheckForUpdates()
  }
  const helpItems: MenuItemConstructorOptions[] = [
    {
      label: 'Quick How-To',
      accelerator: 'CommandOrControl+/',
      click: () => onShowHelp('howto')
    },
    { label: 'User Guide', click: () => onShowHelp('guide') }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              checkForUpdates,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => zoomBy(0) },
        // no accelerators here: see installZoomKeys
        { label: 'Zoom In', click: () => zoomBy(ZOOM_STEP) },
        { label: 'Zoom Out', click: () => zoomBy(-ZOOM_STEP) },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: isMac ? helpItems : [...helpItems, { type: 'separator' }, checkForUpdates]
    } as MenuItemConstructorOptions
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
