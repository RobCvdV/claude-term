import { app, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Install the application menu. This mirrors Electron's default menu (standard
 * Edit/View/Window roles, so clipboard, zoom, devtools etc. keep working) and
 * adds a "Check for Updates…" item — under the app menu on macOS, under Help
 * elsewhere.
 */
export function installAppMenu(onCheckForUpdates: () => void): void {
  const isMac = process.platform === 'darwin'
  const checkForUpdates: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => onCheckForUpdates()
  }

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
    ...(!isMac ? [{ role: 'help', submenu: [checkForUpdates] } as MenuItemConstructorOptions] : [])
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
