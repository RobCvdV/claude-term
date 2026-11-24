import { BrowserWindow, screen, shell } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { WindowBounds } from '../shared/types'
import { bringForward, showWindow } from './background-mode'
import { usableBounds } from './window-order'

interface Saved {
  bounds?: WindowBounds
  /** open when the app last quit: it opens again on launch */
  open?: boolean
}

const SAVE_DELAY_MS = 500

/** Which panel: its title and the query string the renderer picks it by. */
export interface PanelKind {
  title: string
  query: string
}

/**
 * An app-wide panel in a window of its own (Mission control, the Work board):
 * one per app, beside the terminal windows until closed. It keeps the size
 * and place it was given, and opens again on launch if it was open at quit.
 */
export class PanelWindow {
  private win: BrowserWindow | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly kind: PanelKind,
    private readonly file: () => string,
    /** a quit is closing every window: the panel stays "open" */
    private readonly quitting: () => boolean
  ) {}

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  /** Open it, or bring it forward; `inactive` (a launch) leaves the keys alone. */
  open(inactive = false): void {
    if (this.isOpen()) {
      bringForward(this.win!)
      return
    }
    const bounds = usableBounds(
      this.read().bounds,
      screen.getAllDisplays().map((d) => d.workArea)
    )
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      ...bounds,
      minWidth: 360,
      minHeight: 240,
      show: false,
      title: this.kind.title,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true
      }
    })
    this.win = win
    win.on('ready-to-show', () => showWindow(win, inactive))
    const track = (): void => this.scheduleSave(win)
    win.on('moved', track)
    win.on('resized', track)
    win.on('close', () => this.save(win, this.quitting()))
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    // the cards' links (ticket, PR, build) belong in the browser
    win.webContents.setWindowOpenHandler((details) => {
      if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
      return { action: 'deny' }
    })
    const query = this.kind.query
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + query)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
    }
    this.save(win, true)
  }

  /** Open it again if it was open when the app last quit. */
  restore(): void {
    if (this.read().open) this.open(true)
  }

  /** The last terminal window is gone: close too, and open again next launch. */
  closeForQuit(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    this.save(win, true)
    win.destroy()
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.isOpen()) this.win!.webContents.send(channel, ...args)
  }

  private scheduleSave(win: BrowserWindow): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      if (!win.isDestroyed()) this.save(win, true)
    }, SAVE_DELAY_MS)
  }

  private save(win: BrowserWindow, open: boolean): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (win.isDestroyed()) return
    try {
      writeFileSync(this.file(), JSON.stringify({ bounds: win.getNormalBounds(), open }))
    } catch {
      // not remembered — it opens at the default size next time
    }
  }

  private read(): Saved {
    try {
      return JSON.parse(readFileSync(this.file(), 'utf8')) as Saved
    } catch {
      return {}
    }
  }
}
