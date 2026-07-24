import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'

// electron-updater is CommonJS with a default export; destructure it (the
// `import { autoUpdater }` form breaks under the bundler's ESM interop).
const { autoUpdater } = electronUpdater

const HOUR_MS = 60 * 60 * 1000
// periodic background check cadence (checks are cheap — just a small feed fetch)
const CHECK_INTERVAL_MS = 6 * HOUR_MS
// don't let the focus-triggered check run more often than this
const FOCUS_CHECK_MIN_GAP_MS = HOUR_MS

// The version of an update that finished downloading and is waiting for the
// user's OK to install. null = nothing pending.
let downloadedVersion: string | null = null

// epoch ms of the last check we kicked off (any path) — throttles focus checks
let lastCheckAt = 0

/**
 * Background update checks (on launch, every few hours, and whenever the app
 * regains focus — throttled). No-op unless the app is packaged — the updater
 * needs a code-signed build and the published latest-*.yml feeds (read from the
 * bundled app-update.yml). Updates download automatically but are NOT installed
 * until the user consents (autoInstallOnAppQuit = false); the renderer surfaces
 * a header pill and calls back through `confirmAndInstall`.
 */
export function setupUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    send('update:downloaded', info.version)
  })
  // Never let a failed check (offline, rate-limited, unsigned dev build) crash
  // or interrupt the app — updates are best-effort.
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err instanceof Error ? err.message : err)
  })

  check() // on launch
  setInterval(check, CHECK_INTERVAL_MS) // and periodically
  // catch the common "came back to the app after a while" case, throttled so
  // rapid focus toggles don't hammer the feed. Nothing to do once an update is
  // already downloaded and waiting.
  app.on('browser-window-focus', () => {
    if (downloadedVersion) return
    if (Date.now() - lastCheckAt >= FOCUS_CHECK_MIN_GAP_MS) check()
  })
}

function check(): void {
  lastCheckAt = Date.now()
  autoUpdater.checkForUpdates().catch((e) => console.error('[updater] check failed', e))
}

/** Ask the user to restart & install the downloaded update. On consent, run
 *  `prepareQuit` (so the app tears down cleanly without the normal quit prompts)
 *  and relaunch into the installer. Returns whether the install was started. */
export function confirmAndInstall(
  getWindow: () => BrowserWindow | null,
  prepareQuit: () => void
): boolean {
  if (!downloadedVersion) return false
  const win = getWindow()
  const opts: Electron.MessageBoxSyncOptions = {
    type: 'question',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: `Restart to update to v${downloadedVersion}?`,
    detail: 'Your tabs and sessions will reopen and reconnect.'
  }
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)
  if (choice !== 0) return false
  prepareQuit()
  // (isSilent=false, isForceRunAfter=true): show the brief installer on Windows
  // but always relaunch afterwards; macOS always relaunches. The relaunched app
  // restores its tabs + resumes/reattaches sessions via the normal startup path.
  autoUpdater.quitAndInstall(false, true)
  return true
}

/**
 * Manual "Check for Updates…" from the app menu. Unlike the silent background
 * checks, this always reports an outcome: already-downloaded → the install
 * prompt; a newer version → "downloading, you'll be prompted"; nothing new →
 * "up to date"; a failure → a warning. Dev builds can't update, so it says so.
 */
export function checkForUpdatesInteractive(
  getWindow: () => BrowserWindow | null,
  prepareQuit: () => void
): void {
  const win = getWindow()
  const box = (opts: Electron.MessageBoxOptions): void => {
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
  }

  if (!app.isPackaged) {
    box({
      type: 'info',
      message: 'Updates are only available in the installed app.',
      detail: 'This is a development build — nothing to update.'
    })
    return
  }
  // An update already finished downloading in the background: go straight to
  // the restart-to-install prompt rather than re-checking.
  if (downloadedVersion) {
    confirmAndInstall(getWindow, prepareQuit)
    return
  }

  const onAvailable = (info: { version: string }): void => {
    cleanup()
    box({
      type: 'info',
      message: `Update v${info.version} available`,
      detail: "Downloading now — you'll be prompted to restart when it's ready."
    })
  }
  const onNone = (): void => {
    cleanup()
    box({
      type: 'info',
      message: "You're up to date",
      detail: `v${app.getVersion()} is the latest version.`
    })
  }
  const onError = (err: unknown): void => {
    cleanup()
    box({
      type: 'warning',
      message: 'Update check failed',
      detail: err instanceof Error ? err.message : String(err)
    })
  }
  const cleanup = (): void => {
    autoUpdater.off('update-available', onAvailable)
    autoUpdater.off('update-not-available', onNone)
    autoUpdater.off('error', onError)
  }

  autoUpdater.once('update-available', onAvailable)
  autoUpdater.once('update-not-available', onNone)
  autoUpdater.once('error', onError)
  check()
}
