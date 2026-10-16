import { BrowserWindow, dialog, screen, type WebContents } from 'electron'
import type {
  HandoffTarget,
  PersistedSession,
  PersistedSessionFile,
  TabHandoff,
  TabId,
  WindowBoot,
  WindowBounds,
  WindowChoice
} from '../shared/types'
import { appSettings } from './app-settings'
import {
  nextWindowId,
  sessionFileOf,
  spatialOrder,
  stepTabId,
  usableBounds,
  windowAtTabBar
} from './window-order'

interface Entry {
  win: BrowserWindow
  /** order of creation — the oldest open window is the "main" one */
  seq: number
  /** handed out on the first boot; a reload restores `slice` instead */
  boot: WindowBoot | null
  booted: boolean
  /** what its renderer last saved */
  slice: PersistedSession | null
  /** kept up to date so a closed window still reports where it was */
  bounds: WindowBounds
  tabOrder: TabId[]
  activeTab: TabId | null
  activeTitle: string
  /** tabs sent here before the renderer could take them */
  pendingAdopt: TabHandoff[]
}

export interface WindowHooks {
  /** build + load a terminal BrowserWindow (index.ts owns the options) */
  make: (bounds: WindowBounds | undefined) => BrowserWindow
  /** kill the tabs of a window closed with "Close Tabs" */
  disposeTabs: (tabIds: TabId[]) => Promise<void>
  /** an adopted tab's status, re-sent to its new window */
  resendStatus: (tabId: TabId) => void
  /** the session file changed (a slice, a window gone, bounds) */
  persist: (file: PersistedSessionFile) => void
  /** last terminal window gone */
  allClosed: () => void
}

/**
 * Every terminal window, which one owns each tab, and the routing that follows
 * from it: a tab's PTY output, status and attention go to its own window only.
 * A tab moving between windows is "in transit" — its traffic is held here and
 * flushed to the new window once that window has rebuilt the tab.
 */
export class TerminalWindows {
  private entries = new Map<number, Entry>()
  /** windows that closed on the way out (or last): still part of the saved session */
  private retained: Entry[] = []
  private owner = new Map<TabId, number>()
  private transit = new Map<TabId, Array<[string, unknown[]]>>()
  private seq = 0
  private lastFocused: number | null = null
  private persistTimer: NodeJS.Timeout | null = null
  /** set on the way out: windows closing then must not ask or forget their tabs */
  quitting = false
  hooks: WindowHooks | null = null

  create(boot: WindowBoot, bounds?: WindowBounds): BrowserWindow {
    if (!this.hooks) throw new Error('TerminalWindows used before hooks were set')
    const usable =
      bounds && appSettings().restoreWindowBounds
        ? usableBounds(
            bounds,
            screen.getAllDisplays().map((d) => d.workArea)
          )
        : undefined
    const win = this.hooks.make(usable)
    const id = win.id
    this.entries.set(id, {
      win,
      seq: ++this.seq,
      boot,
      booted: false,
      slice: boot.mode === 'restore' ? boot.session : null,
      bounds: win.getBounds(),
      tabOrder: [],
      activeTab: null,
      activeTitle: '',
      pendingAdopt: []
    })
    win.on('focus', () => (this.lastFocused = id))
    const track = (): void => {
      const entry = this.entries.get(id)
      if (entry && !win.isDestroyed()) entry.bounds = win.getBounds()
      this.schedulePersist()
    }
    win.on('moved', track)
    win.on('resized', track)
    win.on('close', (e) => this.onClose(id, e))
    win.on('closed', () => this.onClosed(id))
    return win
  }

  /** a new, empty-handed window next to the focused one */
  createFresh(cwd: string | null = null): BrowserWindow {
    const from = this.focusedOrPrimary()?.getBounds()
    return this.create(
      { mode: 'fresh', cwd },
      from ? { ...from, x: from.x + 30, y: from.y + 30 } : undefined
    )
  }

  count(): number {
    return this.entries.size
  }

  all(): BrowserWindow[] {
    return [...this.entries.values()].map((e) => e.win)
  }

  isTerminalWindow(win: BrowserWindow | null): boolean {
    return !!win && this.entries.has(win.id)
  }

  anyFocused(): boolean {
    return this.all().some((w) => !w.isDestroyed() && w.isFocused())
  }

  anyVisible(): boolean {
    return this.all().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
  }

  /** the oldest open terminal window, optionally not `exceptId` */
  primary(exceptId?: number): BrowserWindow | null {
    const list = [...this.entries.values()].filter((e) => e.win.id !== exceptId)
    list.sort((a, b) => a.seq - b.seq)
    return list[0]?.win ?? null
  }

  focusedOrPrimary(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && this.entries.has(focused.id)) return focused
    const last = this.lastFocused !== null ? this.entries.get(this.lastFocused) : undefined
    return last?.win ?? this.primary()
  }

  fromSender(sender: WebContents): BrowserWindow | null {
    const win = BrowserWindow.fromWebContents(sender)
    return win && this.entries.has(win.id) ? win : null
  }

  // ---- boot + persistence ----

  /** what the sender's renderer should show; queued adoptions follow right after */
  boot(sender: WebContents): WindowBoot {
    const win = this.fromSender(sender)
    const entry = win ? this.entries.get(win.id) : undefined
    if (!entry) return { mode: 'fresh', cwd: null }
    const plan: WindowBoot = entry.boot ?? {
      mode: 'restore',
      session: entry.slice ?? { tabs: [], activeIndex: 0 }
    }
    entry.boot = null
    entry.booted = true
    if (entry.pendingAdopt.length > 0) {
      const handoffs = entry.pendingAdopt
      entry.pendingAdopt = []
      setImmediate(() => this.sendAdopt(entry, handoffs))
    }
    return plan
  }

  saveSlice(sender: WebContents, session: PersistedSession): PersistedSessionFile | null {
    const win = this.fromSender(sender)
    const entry = win ? this.entries.get(win.id) : undefined
    if (!entry) return null
    entry.slice = session
    return this.sessionFile()
  }

  sessionFile(): PersistedSessionFile {
    const list = [...this.entries.values(), ...this.retained].sort((a, b) => a.seq - b.seq)
    return sessionFileOf(
      list
        .filter((e) => e.slice && e.slice.tabs.length > 0)
        .map((e) => ({ ...(e.slice as PersistedSession), bounds: e.bounds }))
    )
  }

  private schedulePersist(): void {
    if (this.quitting) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => this.hooks?.persist(this.sessionFile()), 500)
  }

  // ---- tab ownership + routing ----

  assign(tabId: TabId, sender: WebContents): void {
    const win = this.fromSender(sender)
    if (win) this.owner.set(tabId, win.id)
  }

  release(tabId: TabId): void {
    this.owner.delete(tabId)
    this.transit.delete(tabId)
  }

  tabsOf(sender: WebContents): TabId[] {
    const win = this.fromSender(sender)
    return win ? this.tabsOfWindow(win.id) : []
  }

  private tabsOfWindow(id: number): TabId[] {
    return [...this.owner].filter(([, w]) => w === id).map(([t]) => t)
  }

  /** tab-scoped traffic: to the owning window, or held while the tab moves */
  sendForTab(tabId: TabId, channel: string, ...args: unknown[]): void {
    const held = this.transit.get(tabId)
    if (held) {
      held.push([channel, args])
      return
    }
    const id = this.owner.get(tabId)
    const win = id !== undefined ? this.entries.get(id)?.win : undefined
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.all()) if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // ---- moving tabs ----

  /** start holding the tabs' traffic; the source serializes once this returns */
  beginHandoff(tabIds: TabId[]): void {
    for (const t of tabIds) if (!this.transit.has(t)) this.transit.set(t, [])
  }

  handOff(sender: WebContents, handoffs: TabHandoff[], target: HandoffTarget): void {
    const from = this.fromSender(sender)
    const targetWin = this.resolveTarget(target, from)
    const entry = this.entries.get(targetWin.id)
    if (!entry) return
    if (entry.booted) this.sendAdopt(entry, handoffs)
    else entry.pendingAdopt.push(...handoffs)
    targetWin.show()
    targetWin.focus()
  }

  /** the window whose tab bar a dragged tab is over, if any but its own */
  private dropTarget(from: BrowserWindow | null, x: number, y: number): number | null {
    const others = [...this.entries.values()]
      .filter((e) => e.win !== from && e.win.isVisible() && !e.win.isMinimized())
      .map((e) => ({ id: e.win.id, bounds: e.win.getContentBounds() }))
    return windowAtTabBar(others, x, y)
  }

  private hoverId: number | null = null

  /** light up the tab bar a dragged tab would join */
  dragHover(sender: WebContents | null, x?: number, y?: number): void {
    const next =
      sender && x !== undefined && y !== undefined
        ? this.dropTarget(this.fromSender(sender), x, y)
        : null
    if (next === this.hoverId) return
    for (const [id, on] of [
      [this.hoverId, false],
      [next, true]
    ] as const) {
      const win = id !== null ? this.entries.get(id)?.win : undefined
      if (win && !win.isDestroyed()) win.webContents.send('tabs:dropHover', on)
    }
    this.hoverId = next
  }

  private resolveTarget(target: HandoffTarget, from: BrowserWindow | null): BrowserWindow {
    const size = from?.getBounds() ?? { width: 1200, height: 800 }
    const at = (x: number, y: number): BrowserWindow =>
      this.create(
        { mode: 'adopt' },
        { x: x - 120, y: y - 20, width: size.width, height: size.height }
      )
    if (target.kind === 'window') {
      const win = this.entries.get(target.windowId)?.win
      if (win && !win.isDestroyed()) return win
      return this.createAdoptNear(from)
    }
    if (target.kind === 'drop') {
      const hit = this.dropTarget(from, target.x, target.y)
      if (hit !== null) return this.entries.get(hit)!.win
      return at(target.x, target.y)
    }
    return target.at ? at(target.at.x, target.at.y) : this.createAdoptNear(from)
  }

  private createAdoptNear(from: BrowserWindow | null): BrowserWindow {
    const b = from?.getBounds()
    return this.create({ mode: 'adopt' }, b ? { ...b, x: b.x + 30, y: b.y + 30 } : undefined)
  }

  private sendAdopt(entry: Entry, handoffs: TabHandoff[]): void {
    if (!entry.win.isDestroyed()) entry.win.webContents.send('tabs:adopt', handoffs)
  }

  /** the target rebuilt these tabs: they are its own now, held traffic follows */
  adopted(sender: WebContents, tabIds: TabId[]): void {
    const win = this.fromSender(sender)
    if (!win) return
    for (const tabId of tabIds) {
      this.owner.set(tabId, win.id)
      const held = this.transit.get(tabId) ?? []
      this.transit.delete(tabId)
      for (const [channel, args] of held) win.webContents.send(channel, ...args)
      this.hooks?.resendStatus(tabId)
    }
  }

  /** a window handed its last tab away: close it, unless it's the only one */
  emptied(sender: WebContents): void {
    const win = this.fromSender(sender)
    if (!win || this.entries.size < 2) return
    const entry = this.entries.get(win.id)
    if (entry) entry.slice = null
    win.destroy()
  }

  // ---- tab navigation across windows ----

  reportTabs(sender: WebContents, tabIds: TabId[], activeTab: TabId | null, title: string): void {
    const win = this.fromSender(sender)
    const entry = win ? this.entries.get(win.id) : undefined
    if (!entry) return
    entry.tabOrder = tabIds
    entry.activeTab = activeTab
    entry.activeTitle = title
  }

  private spatial(): Entry[] {
    return spatialOrder(
      [...this.entries.values()].map((e) => ({ id: e.win.id, bounds: e.win.getBounds(), e }))
    ).map((w) => w.e)
  }

  private globalTabs(): TabId[] {
    return this.spatial().flatMap((e) => e.tabOrder)
  }

  /** ⌘1–9 over every window's tabs, left to right */
  selectGlobal(index: number): void {
    const tabId = this.globalTabs()[index]
    if (tabId) this.activate(tabId)
  }

  stepGlobal(sender: WebContents, delta: number): void {
    const win = this.fromSender(sender)
    const current = win ? (this.entries.get(win.id)?.activeTab ?? null) : null
    const tabId = stepTabId(this.globalTabs(), current, delta)
    if (tabId) this.activate(tabId)
  }

  /** bring the tab's window forward and switch it to the tab */
  activate(tabId: TabId): void {
    const id = this.owner.get(tabId)
    const win = id !== undefined ? this.entries.get(id)?.win : undefined
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('tabs:activate', tabId)
  }

  /** ⌃`: the next terminal window, skipping file and docs windows */
  cycle(): void {
    const focused = BrowserWindow.getFocusedWindow()
    const order = this.spatial().map((e) => e.win.id)
    const nextId =
      focused && this.entries.has(focused.id)
        ? nextWindowId(order, focused.id)
        : (this.focusedOrPrimary()?.id ?? null)
    const win = nextId !== null ? this.entries.get(nextId)?.win : undefined
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  /** the other windows a tab can move to, labelled by position and active tab */
  choicesFor(sender: WebContents): WindowChoice[] {
    const self = this.fromSender(sender)
    return this.spatial()
      .map((e, i) => ({ e, n: i + 1 }))
      .filter(({ e }) => e.win !== self)
      .map(({ e, n }) => ({
        windowId: e.win.id,
        label: `Window ${n}${e.activeTitle ? ` — ${e.activeTitle}` : ''}`
      }))
  }

  // ---- closing ----

  private onClose(id: number, e: Electron.Event): void {
    if (this.quitting || this.entries.size < 2) return
    const tabs = this.tabsOfWindow(id)
    const entry = this.entries.get(id)
    if (!entry || tabs.length === 0) {
      if (entry) entry.slice = null
      return
    }
    e.preventDefault()
    const n = tabs.length
    const choice = dialog.showMessageBoxSync(entry.win, {
      type: 'question',
      buttons: ['Cancel', 'Close Tabs', 'Move to Main Window'],
      defaultId: 2,
      cancelId: 0,
      message: `This window has ${n} tab${n > 1 ? 's' : ''}.`,
      detail: 'Close them, or move them to the main window?'
    })
    if (choice === 1) {
      entry.slice = null
      void this.hooks?.disposeTabs(tabs).then(() => {
        for (const t of tabs) this.release(t)
        if (!entry.win.isDestroyed()) entry.win.destroy()
      })
    } else if (choice === 2) {
      const main = this.primary(id)
      // the renderer packs its tabs and calls emptied() once they're gone
      if (main) entry.win.webContents.send('tabs:handoffAll', main.id)
    }
  }

  private onClosed(id: number): void {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    if (this.lastFocused === id) this.lastFocused = null
    // quitting, or the last window going (which quits): its tabs restore next launch
    const keep = this.quitting || this.entries.size === 0
    if (entry && keep) this.retained.push(entry)
    else this.hooks?.persist(this.sessionFile())
    if (this.entries.size === 0) this.hooks?.allClosed()
  }
}
