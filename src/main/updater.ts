import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'

// electron-updater is CommonJS with a default export; destructure it (the
// `import { autoUpdater }` form breaks under the bundler's ESM interop).
const { autoUpdater } = electronUpdater

const DAY_MS = 24 * 60 * 60 * 1000

// The version of an update that finished downloading and is waiting for the
// user's OK to install. null = nothing pending.
let downloadedVersion: string | null = null

/**
 * Background update checks (on launch + once a day). No-op unless the app is
 * packaged — the updater needs a code-signed build and the published
 * latest-*.yml feeds (read from the bundled app-update.yml). Updates download
 * automatically but are NOT installed until the user consents
 * (autoInstallOnAppQuit = false); the renderer surfaces a header pill and calls
 * back through `confirmAndInstall`.
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

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((e) => console.error('[updater] check failed', e))
  }
  check() // on launch
  setInterval(check, DAY_MS) // and daily
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
