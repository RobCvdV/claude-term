import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { HelpSection } from '../shared/types'

/**
 * Install the application menu. This mirrors Electron's default menu (standard
 * Edit/View/Window roles, so clipboard, zoom, devtools etc. keep working) and
 * adds a "Check for Updates…" item — under the app menu on macOS, under Help
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
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: isMac ? helpItems : [...helpItems, { type: 'separator' }, checkForUpdates]
    } as MenuItemConstructorOptions
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
