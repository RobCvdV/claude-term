/** A dev instance driven over CDP for checks (scripts/dev-instance.sh) runs
 *  in the background: its windows never take focus or appear on screen, so the
 *  person at the keyboard keeps working undisturbed. */

import { app, type BrowserWindow } from 'electron'

export const inBackground = process.env['CLAUDE_TERM_BACKGROUND'] === '1'

/** Chromium would stop painting windows nobody can see; checks still need
 *  them rendered. Call before the app is ready. */
export function keepBackgroundRendering(): void {
  if (!inBackground) return
  for (const sw of [
    'disable-backgrounding-occluded-windows',
    'disable-renderer-backgrounding',
    'disable-background-timer-throttling'
  ])
    app.commandLine.appendSwitch(sw)
}

/** Shown, but invisible and click-through: even an inactive window would
 *  otherwise be ordered in front of whatever the person is working in. */
function showUnseen(win: BrowserWindow): void {
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  win.showInactive()
}

/** Show a window for the first time. */
export function showWindow(win: BrowserWindow): void {
  if (inBackground) showUnseen(win)
  else win.show()
}

/** Show a window and give it the keys. */
export function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (inBackground) {
    if (!win.isVisible()) showUnseen(win)
    return
  }
  win.show()
  win.focus()
}
