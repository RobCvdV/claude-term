import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Which button the unsaved-changes prompt "clicks": 0 = Save, 1 = Don't Save /
// Discard, 2 = Cancel. Tests set this before triggering a close.
let dialogResponse = 0
type MessageBoxOptions = Record<string, unknown>
// declared as a signature, so the assertions below can read the recorded args
const showMessageBox = vi.fn<
  (win: unknown, opts: MessageBoxOptions) => Promise<{ response: number }>
>(async () => ({ response: dialogResponse }))
const openExternal = vi.fn()

type OpenHandler = (details: { url: string }) => { action: string }

/** A stand-in BrowserWindow: records what was done to it and lets tests fire
 *  the window events the real one would ('close', 'ready-to-show', …). */
class FakeWindow {
  static created: FakeWindow[] = []
  options: Record<string, unknown>
  handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  webContents = {
    send: vi.fn<(channel: string, payload?: unknown) => void>(),
    setWindowOpenHandler: vi.fn<(handler: OpenHandler) => void>()
  }
  destroyed = false
  shown = 0
  focused = 0
  restored = 0
  minimized = false
  title: string
  loaded: { file?: string; url?: string; search?: string } = {}

  constructor(options: Record<string, unknown>) {
    this.options = options
    this.title = String(options.title ?? '')
    FakeWindow.created.push(this)
  }
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  show(): void {
    this.shown++
  }
  focus(): void {
    this.focused++
  }
  restore(): void {
    this.restored++
  }
  setTitle(t: string): void {
    this.title = t
  }
  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }
  loadFile(file: string, opts: { search: string }): Promise<void> {
    this.loaded = { file, search: opts.search }
    return Promise.resolve()
  }
  loadURL(url: string): Promise<void> {
    this.loaded = { url }
    return Promise.resolve()
  }
}

/** ipcMain stand-in: tests emit renderer messages through `fire`. */
const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
const ipcMain = {
  on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
    const list = listeners.get(channel) ?? []
    list.push(cb)
    listeners.set(channel, list)
  }),
  removeListener: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
    const list = (listeners.get(channel) ?? []).filter((f) => f !== cb)
    listeners.set(channel, list)
  })
}

function fire(channel: string, sender: unknown, ...args: unknown[]): void {
  for (const cb of [...(listeners.get(channel) ?? [])]) cb({ sender }, ...args)
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  dialog: { showMessageBox },
  ipcMain,
  shell: { openExternal }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

// The module joins paths against __dirname, which an ESM test module lacks.
vi.stubGlobal('__dirname', '/app/out/main')

const { createFileWindows } = await import('./file-window')

interface Open {
  group: string
}

function makeWindows(): ReturnType<typeof createFileWindows<Open>> {
  return createFileWindows<Open>({
    channel: 'docs',
    width: 900,
    height: 720,
    subject: 'document',
    query: (tabId, title, open) => `?docs=1&tabId=${tabId}&group=${open.group}&title=${title}`,
    retarget: (win, title, open) => win.webContents.send('docs:setGroup', { title, ...open })
  })
}

let windows: ReturnType<typeof createFileWindows<Open>>

beforeEach(() => {
  FakeWindow.created = []
  listeners.clear()
  showMessageBox.mockClear()
  openExternal.mockClear()
  dialogResponse = 0
  windows = makeWindows()
})

afterEach(() => {
  vi.useRealTimers()
})

/** The window opened for `tab`, as the fake it really is. */
function win(index = 0): FakeWindow {
  return FakeWindow.created[index]
}

/** Report unsaved changes from a window's renderer. */
function reportDirty(w: FakeWindow, dirty = true): void {
  fire('docs:dirty', w.webContents, dirty)
}

/** Let every pending promise settle, so "did NOT happen" assertions are real
 *  rather than just running ahead of the close chain. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('opening', () => {
  it('creates one window per tab, sized and titled by the spec', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    windows.openOrFocus('tab-2', 'Other', { group: 'plan' })

    expect(FakeWindow.created).toHaveLength(2)
    expect(win(0).options).toMatchObject({ width: 900, height: 720, show: false, title: 'Project' })
    expect(win(0).loaded.search).toBe('?docs=1&tabId=tab-1&group=docs&title=Project')
    expect(win(1).loaded.search).toBe('?docs=1&tabId=tab-2&group=plan&title=Other')
  })

  it('uses the spec’s own OS title when it has one', () => {
    const titled = createFileWindows<Open>({
      channel: 'titled',
      width: 900,
      height: 720,
      subject: 'document',
      osTitle: (t) => `File editor — ${t}`,
      query: (tabId) => `?tabId=${tabId}`,
      retarget: () => {}
    })
    titled.openOrFocus('tab-1', 'Project', { group: 'docs' })
    // the window's own title carries the prefix; the renderer is told the plain
    // one, so it can compose its own without doubling it up
    expect(win().options.title).toBe('File editor — Project')
    expect(win().loaded.search).toBe('?tabId=tab-1')
  })

  it('shows the window once the renderer is ready', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    expect(win().shown).toBe(0)
    win().emit('ready-to-show')
    expect(win().shown).toBe(1)
  })

  it('focuses and retargets an already-open window instead of opening a second', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    windows.openOrFocus('tab-1', 'Project — plan', { group: 'plan' })

    expect(FakeWindow.created).toHaveLength(1)
    expect(win().focused).toBe(1)
    expect(win().webContents.send).toHaveBeenCalledWith('docs:setGroup', {
      title: 'Project — plan',
      group: 'plan'
    })
  })

  it('un-minimizes a window it is re-focusing', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    win().minimized = true
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    expect(win().restored).toBe(1)
  })

  it('opens a fresh window when the previous one was destroyed', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    win().destroyed = true // destroyed without its 'closed' event reaching us
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    expect(FakeWindow.created).toHaveLength(2)
  })

  it('sends external links to the browser and never opens app windows', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    const handler = win().webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(handler({ url: 'https://example.com/x' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x')
    openExternal.mockClear()
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('closing a clean window', () => {
  it('closes without prompting', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    const event = { preventDefault: vi.fn() }
    win().emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('forgets the window once it has closed, so the tab can open a new one', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    win().emit('closed')
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    expect(FakeWindow.created).toHaveLength(2)
  })
})

describe('closing with unsaved changes', () => {
  it('prompts with Save / Don’t Save / Cancel and holds the close', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 2 // Cancel

    const event = { preventDefault: vi.fn() }
    win().emit('close', event)
    expect(event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())

    const opts = showMessageBox.mock.calls[0][1]
    expect(opts.buttons).toEqual(['Save', "Don't Save", 'Cancel'])
    expect(opts.message).toBe('Save changes to this document?')
    expect(opts.cancelId).toBe(2)
    // Cancel keeps the window alive
    await flush()
    expect(win().destroyed).toBe(false)
  })

  it('asks the renderer to save, then closes once it confirms', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 0 // Save

    win().emit('close', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(win().webContents.send).toHaveBeenCalledWith('docs:requestSave'))
    await flush()
    expect(win().destroyed).toBe(false) // still waiting for the save

    fire('docs:saveDone', win().webContents)
    await vi.waitFor(() => expect(win().destroyed).toBe(true))
  })

  it('discards without asking the renderer to save', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 1 // Don't Save

    win().emit('close', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(win().destroyed).toBe(true))
    expect(win().webContents.send).not.toHaveBeenCalledWith('docs:requestSave')
  })

  it('gives up on a wedged renderer after the save timeout', async () => {
    vi.useFakeTimers()
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 0 // Save, but saveDone never arrives

    win().emit('close', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(win().webContents.send).toHaveBeenCalledWith('docs:requestSave'))
    expect(win().destroyed).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    expect(win().destroyed).toBe(true)
  })

  it('never prompts twice for the same window', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 1 // Discard

    win().emit('close', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(win().destroyed).toBe(true))

    // a second close (⌘W again, or the OS re-issuing it) must pass straight
    // through — the answer has already been given
    const again = { preventDefault: vi.fn() }
    win().emit('close', again)
    await flush()
    expect(again.preventDefault).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('stops tracking dirty once the renderer reports it saved', () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win(), true)
    reportDirty(win(), false)

    const event = { preventDefault: vi.fn() }
    win().emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('attributes dirty state to the window that reported it', async () => {
    windows.openOrFocus('tab-1', 'One', { group: 'docs' })
    windows.openOrFocus('tab-2', 'Two', { group: 'docs' })
    reportDirty(win(1)) // only the second tab has unsaved edits

    const clean = { preventDefault: vi.fn() }
    win(0).emit('close', clean)
    expect(clean.preventDefault).not.toHaveBeenCalled()

    win(1).emit('close', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))
    expect(showMessageBox.mock.calls[0][0]).toBe(win(1))
  })

  it('only the saving window’s own saveDone releases its close', async () => {
    windows.openOrFocus('tab-1', 'One', { group: 'docs' })
    windows.openOrFocus('tab-2', 'Two', { group: 'docs' })
    reportDirty(win(1))
    dialogResponse = 0

    win(1).emit('close', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(win(1).webContents.send).toHaveBeenCalledWith('docs:requestSave'))

    fire('docs:saveDone', win(0).webContents) // a different window's save
    await flush()
    expect(win(1).destroyed).toBe(false)

    fire('docs:saveDone', win(1).webContents)
    await vi.waitFor(() => expect(win(1).destroyed).toBe(true))
  })
})

describe('closeForTab (the tab itself is closing)', () => {
  it('offers Save / Discard only — the close happens either way', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 1 // Discard

    await windows.closeForTab('tab-1')
    const opts = showMessageBox.mock.calls[0][1]
    expect(opts.buttons).toEqual(['Save', 'Discard'])
    // dismissing the dialog maps to Save here, so edits are never lost silently
    expect(opts.cancelId).toBe(0)
    expect(win().destroyed).toBe(true)
  })

  it('waits for the save to finish before destroying the window', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    reportDirty(win())
    dialogResponse = 0 // Save

    const closing = windows.closeForTab('tab-1')
    await vi.waitFor(() => expect(win().webContents.send).toHaveBeenCalledWith('docs:requestSave'))
    await flush()
    expect(win().destroyed).toBe(false)

    fire('docs:saveDone', win().webContents)
    await closing
    expect(win().destroyed).toBe(true)
  })

  it('closes a clean window with no prompt, and ignores unknown tabs', async () => {
    windows.openOrFocus('tab-1', 'Project', { group: 'docs' })
    await windows.closeForTab('tab-1')
    expect(win().destroyed).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()

    await expect(windows.closeForTab('never-opened')).resolves.toBeUndefined()
  })
})

describe('closeAll (the app is quitting)', () => {
  it('destroys every window without prompting, even dirty ones', () => {
    windows.openOrFocus('tab-1', 'One', { group: 'docs' })
    windows.openOrFocus('tab-2', 'Two', { group: 'docs' })
    reportDirty(win(1))

    windows.closeAll()

    expect(win(0).destroyed).toBe(true)
    expect(win(1).destroyed).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe('independent kinds', () => {
  it('keeps each kind on its own channels and its own windows', () => {
    const config = createFileWindows<void>({
      channel: 'config',
      width: 1000,
      height: 760,
      subject: 'file',
      query: (tabId) => `?config=1&tabId=${tabId}`,
      retarget: (w, title) => w.setTitle(title)
    })

    windows.openOrFocus('tab-1', 'Docs', { group: 'docs' })
    config.openOrFocus('tab-1', 'Settings', undefined)
    expect(FakeWindow.created).toHaveLength(2)

    // a docs dirty report must not mark the settings window dirty
    reportDirty(win(0))
    const event = { preventDefault: vi.fn() }
    win(1).emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
