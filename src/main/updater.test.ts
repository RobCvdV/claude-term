import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The feed's newest release: a version string, or null for "up to date".
let latest: string | null = null
// Handlers registered by setupUpdater, so tests can fire updater events.
let handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
let sent: (string | null)[] = []

const checkForUpdates = vi.fn(async () =>
  latest
    ? { isUpdateAvailable: true, updateInfo: { version: latest } }
    : { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }
)
const quitAndInstall = vi.fn()
// Answer to the restart prompt: 0 = "Restart now", 1 = "Later".
const showMessageBoxSync = vi.fn(() => 0)
const showMessageBox = vi.fn()

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      on: (event: string, cb: (...args: unknown[]) => void) => {
        ;(handlers[event] ??= []).push(cb)
      },
      checkForUpdates,
      quitAndInstall
    }
  }
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', on: vi.fn() },
  BrowserWindow: class {},
  dialog: {
    get showMessageBoxSync() {
      return showMessageBoxSync
    },
    get showMessageBox() {
      return showMessageBox
    }
  }
}))

const win = {
  isDestroyed: () => false,
  webContents: {
    send: (_channel: string, version: string | null) => sent.push(version)
  }
}
const getWindow = (): never => win as never
const prepareQuit = vi.fn()

/** Fresh module state with the updater running and, optionally, `downloaded`
 *  already sitting on disk waiting to install (the header-pill state). */
async function boot(opts: {
  feed: string | null
  downloaded?: string
}): Promise<typeof import('./updater')> {
  vi.resetModules()
  handlers = {}
  sent = []
  latest = opts.feed
  const mod = await import('./updater')
  mod.setupUpdater(getWindow)
  if (opts.downloaded) {
    for (const cb of handlers['update-downloaded'] ?? []) cb({ version: opts.downloaded })
    sent = []
  }
  return mod
}

/** The `message` of the last informational dialog shown. */
function lastMessage(): string {
  return dialogMessage(showMessageBox, -1)
}

/** The `message` of a recorded dialog call. */
function dialogMessage(spy: { mock: { calls: unknown[][] } }, index: number): string {
  const opts = spy.mock.calls.at(index)?.[1] as { message?: string } | undefined
  return String(opts?.message ?? '')
}

beforeEach(() => {
  // setupUpdater schedules a periodic check — keep it out of the test run
  vi.useFakeTimers()
  vi.clearAllMocks()
  showMessageBoxSync.mockReturnValue(0)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('manual "Check for Updates…"', () => {
  it('reports the newest release, not one an earlier check found', async () => {
    // v1.1 was found and downloaded earlier; v1.2 has shipped since
    const mod = await boot({ feed: '1.1', downloaded: '1.1' })
    latest = '1.2'

    await mod.checkForUpdatesInteractive(getWindow, prepareQuit)

    expect(lastMessage()).toContain('1.2')
    expect(showMessageBoxSync).not.toHaveBeenCalled() // no install of the old one
    expect(sent).toEqual([null]) // stale pill withdrawn
  })

  it('offers to install when the downloaded update is still the newest', async () => {
    const mod = await boot({ feed: '1.1', downloaded: '1.1' })

    await mod.checkForUpdatesInteractive(getWindow, prepareQuit)

    expect(dialogMessage(showMessageBoxSync, 0)).toContain('1.1')
    expect(quitAndInstall).toHaveBeenCalled()
  })

  it('says up to date and drops the pill when the release is gone', async () => {
    const mod = await boot({ feed: '1.1', downloaded: '1.1' })
    latest = null

    await mod.checkForUpdatesInteractive(getWindow, prepareQuit)

    expect(lastMessage()).toContain('up to date')
    expect(sent).toEqual([null])
  })

  it('warns when the check fails', async () => {
    const mod = await boot({ feed: null })
    checkForUpdates.mockRejectedValueOnce(new Error('offline'))

    await mod.checkForUpdatesInteractive(getWindow, prepareQuit)

    expect(lastMessage()).toContain('failed')
  })
})

describe('header update pill', () => {
  it('re-checks first and refuses to install a superseded download', async () => {
    const mod = await boot({ feed: '1.1', downloaded: '1.1' })
    latest = '1.2'

    expect(await mod.installUpdate(getWindow, prepareQuit)).toBe(false)
    expect(quitAndInstall).not.toHaveBeenCalled()
    expect(lastMessage()).toContain('1.2')
  })

  it('installs when the download is confirmed newest', async () => {
    const mod = await boot({ feed: '1.1', downloaded: '1.1' })

    expect(await mod.installUpdate(getWindow, prepareQuit)).toBe(true)
    expect(prepareQuit).toHaveBeenCalled()
    expect(quitAndInstall).toHaveBeenCalled()
  })

  it('still installs when the re-check fails, e.g. offline', async () => {
    const mod = await boot({ feed: '1.1', downloaded: '1.1' })
    checkForUpdates.mockRejectedValueOnce(new Error('offline'))

    expect(await mod.installUpdate(getWindow, prepareQuit)).toBe(true)
    expect(quitAndInstall).toHaveBeenCalled()
  })
})
