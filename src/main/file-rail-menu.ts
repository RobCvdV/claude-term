import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { RailAction, RailMenuRequest } from '../shared/types'
import { revealLabel } from '../shared/reveal-label'

/** How long a closed menu waits for its click to land: on macOS the click
 *  handler can run after the close callback. */
const CLICK_GRACE_MS = 50

/** The file rail's right-click (and ⌃Space) menu. Resolves to the picked
 *  action, or null when it was dismissed; the window carries the action out,
 *  since it is the same code its keys run. */
export function showRailMenu(win: BrowserWindow, req: RailMenuRequest): Promise<RailAction | null> {
  return new Promise((done) => {
    let settled = false
    const pick = (action: RailAction | null): void => {
      if (settled) return
      settled = true
      done(action)
    }
    const item = (
      label: string,
      action: RailAction,
      accelerator?: string,
      extra: Partial<MenuItemConstructorOptions> = {}
    ): MenuItemConstructorOptions => ({
      label,
      accelerator,
      // shown as a hint only: the keys themselves are the window's
      registerAccelerator: false,
      click: () => pick(action),
      ...extra
    })
    const file = !req.isDir
    const template: MenuItemConstructorOptions[] = [
      ...(file
        ? [
            item('Open', 'open', 'Enter'),
            item('Open with Default App', 'openDefault', 'CommandOrControl+O'),
            item('Quick Look', 'quickLook', 'Space')
          ]
        : []),
      item(revealLabel(process.platform), 'reveal'),
      { type: 'separator' },
      item('Copy', 'copy', 'CommandOrControl+C'),
      item('Copy Path', 'copyPath', 'Alt+CommandOrControl+C'),
      item('Paste', 'paste', 'CommandOrControl+V', {
        enabled: req.inTree,
        toolTip: req.inTree ? undefined : 'Paste into a project folder, not Quick Access'
      })
    ]
    Menu.buildFromTemplate(template).popup({
      window: win,
      x: Math.round(req.x),
      y: Math.round(req.y),
      callback: () => setTimeout(() => pick(null), CLICK_GRACE_MS)
    })
  })
}
