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

// Renderer notifier, wired up by setupUpdater — lets a check clear a stale
// pill when the release it pointed at is no longer the newest.
let notifyRenderer: (version: string | null) => void = () => {}

type CheckResult =
  { kind: 'available'; version: string } | { kind: 'none' } | { kind: 'error'; error: unknown }

/**
 * Background update checks (on launch, every few hours, and whenever the app
 * regains focus — throttled). No-op unless the app is packaged — the updater
 * needs a code-signed build and the published latest-*.yml feeds (read from the
 * bundled app-update.yml). Updates download automatically but are NOT installed
 * until the user consents (autoInstallOnAppQuit = false); the renderer surfaces
 * a header pill and calls back through `installUpdate`.
 */
export function setupUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  notifyRenderer = (version) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update:downloaded', version)
  }

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    notifyRenderer(info.version)
  })
  // Never let a failed check (offline, rate-limited, unsigned dev build) crash
  // or interrupt the app — updates are best-effort.
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err instanceof Error ? err.message : err)
  })

  void check() // on launch
  setInterval(() => void check(), CHECK_INTERVAL_MS) // and periodically
  // catch the common "came back to the app after a while" case, throttled so
  // rapid focus toggles don't hammer the feed. Nothing to do once an update is
  // already downloaded and waiting.
  app.on('browser-window-focus', () => {
    if (downloadedVersion) return
    if (Date.now() - lastCheckAt >= FOCUS_CHECK_MIN_GAP_MS) void check()
  })
}

/**
 * Hit the release feed and report what it says. Always a fresh fetch, so the
 * answer reflects the newest published release rather than whatever an earlier
 * check happened to find. When the newest release is no longer the one we have
 * downloaded, that download is forgotten (and the header pill withdrawn) so it
 * can never be installed in place of the newer one.
 */
async function check(): Promise<CheckResult> {
  lastCheckAt = Date.now()
  try {
    const result = await autoUpdater.checkForUpdates()
    // null when the updater is inactive (unpackaged build)
    if (!result) return { kind: 'none' }
    if (!result.isUpdateAvailable) {
      forget()
      return { kind: 'none' }
    }
    const version = result.updateInfo.version
    if (downloadedVersion && downloadedVersion !== version) forget()
    return { kind: 'available', version }
  } catch (e) {
    console.error('[updater] check failed', e)
    return { kind: 'error', error: e }
  }
}

/** Drop a no-longer-newest download and withdraw the header pill. */
function forget(): void {
  if (!downloadedVersion) return
  downloadedVersion = null
  notifyRenderer(null)
}

/** Ask the user to restart & install the downloaded update. On consent, await
 *  `prepareQuit` (so the app tears down cleanly without the normal quit prompts)
 *  and relaunch into the installer. Returns whether the install was started. */
async function promptAndInstall(
  getWindow: () => BrowserWindow | null,
  prepareQuit: () => Promise<void>
): Promise<boolean> {
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
  await prepareQuit()
  // (isSilent=false, isForceRunAfter=true): show the brief installer on Windows
  // but always relaunch afterwards; macOS always relaunches. The relaunched app
  // restores its tabs + resumes/reattaches sessions via the normal startup path.
  autoUpdater.quitAndInstall(false, true)
  return true
}

/**
 * The header pill's "⬆ Update vX" button. Re-checks the feed before installing:
 * the pill may have been sitting there long enough for a newer release to have
 * shipped, and we must never install a superseded one. A newer release starts
 * downloading and the user is told to expect the restart prompt. Only when the
 * check confirms our download is still the newest — or the check itself fails,
 * e.g. offline — do we go ahead and offer to install it.
 */
export async function installUpdate(
  getWindow: () => BrowserWindow | null,
  prepareQuit: () => Promise<void>
): Promise<boolean> {
  const pending = downloadedVersion
  const result = await check()
  if (result.kind === 'available' && result.version !== pending) {
    box(getWindow, {
      type: 'info',
      message: `A newer update v${result.version} is available`,
      detail: "Downloading now — you'll be prompted to restart when it's ready."
    })
    return false
  }
  if (result.kind === 'none' && !downloadedVersion) {
    box(getWindow, {
      type: 'info',
      message: "You're up to date",
      detail: `v${app.getVersion()} is the latest version.`
    })
    return false
  }
  return promptAndInstall(getWindow, prepareQuit)
}

/**
 * Manual "Check for Updates…" from the app menu. Always re-checks the feed, so
 * it reports the newest published release even if an earlier check already found
 * (and downloaded) an older one. Outcomes: newest release already downloaded →
 * the install prompt; a newer release → "downloading, you'll be prompted";
 * nothing new → "up to date"; a failure → a warning. Dev builds can't update.
 */
export async function checkForUpdatesInteractive(
  getWindow: () => BrowserWindow | null,
  prepareQuit: () => Promise<void>
): Promise<void> {
  if (!app.isPackaged) {
    box(getWindow, {
      type: 'info',
      message: 'Updates are only available in the installed app.',
      detail: 'This is a development build — nothing to update.'
    })
    return
  }

  const pending = downloadedVersion
  const result = await check()

  if (result.kind === 'error') {
    box(getWindow, {
      type: 'warning',
      message: 'Update check failed',
      detail: result.error instanceof Error ? result.error.message : String(result.error)
    })
    return
  }
  if (result.kind === 'none') {
    box(getWindow, {
      type: 'info',
      message: "You're up to date",
      detail: `v${app.getVersion()} is the latest version.`
    })
    return
  }
  // The newest release is the one already sitting on disk — offer to install it.
  if (result.version === pending) {
    await promptAndInstall(getWindow, prepareQuit)
    return
  }
  box(getWindow, {
    type: 'info',
    message: `Update v${result.version} available`,
    detail: "Downloading now — you'll be prompted to restart when it's ready."
  })
}

function box(getWindow: () => BrowserWindow | null, opts: Electron.MessageBoxOptions): void {
  const win = getWindow()
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
}
