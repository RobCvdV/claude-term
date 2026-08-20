import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createServices, registerIpc } from './ipc'
import { ensureActivityHook } from './activity-hook-install'
import { loginShellEnv } from './shell-env'
import { findOwnBackgroundAgents, stopBackgroundAgent, type LiveAgent } from './agents'
import { setupUpdater, installUpdate, checkForUpdatesInteractive } from './updater'
import { installAppMenu } from './menu'
import { closeAllDocsWindows } from './docs-window'
import { CiPoller } from './ci-status'

// userData isolation (session.json, zdotdir, forwarder). Must happen before
// anything reads app.getPath('userData').
//
// A dev (`npm run dev`) or CDP-instrumented run must NEVER share the packaged
// app's profile: package name and productName are both "claude-term", so the
// default userData is the same dir, and a test instance quitting would clobber
// the real session.json tab list (happened 2026-07-21). Precedence:
//   1. CLAUDE_TERM_USER_DATA_DIR — explicit override for E2E fixtures
//   2. unpackaged (dev) run      → claude-term-dev
//   3. packaged but CDP debug port requested → claude-term-debug
if (process.env['CLAUDE_TERM_USER_DATA_DIR']) {
  app.setPath('userData', process.env['CLAUDE_TERM_USER_DATA_DIR'] as string)
} else if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'claude-term-dev'))
} else if (
  process.env['CLAUDE_TERM_DEBUG_PORT'] ||
  process.argv.some((a) => a.startsWith('--remote-debugging-port'))
) {
  app.setPath('userData', join(app.getPath('appData'), 'claude-term-debug'))
}

// One instance per profile: a second instance sharing this userData dir would
// race the first on session.json (and the two would cross-talk on ports).
// Dev/debug/E2E runs use their own dirs (above), so they coexist with the
// packaged app — this only stops true duplicates of the same profile.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

let mainWindow: BrowserWindow | null = null
const services = createServices(() => mainWindow)

// Live CI state per repo+branch (Jenkins / Actions / CircleCI) — polls only
// while the window is actually on screen; results ride status:update.
const ciPoller = new CiPoller(
  () => services.status.allSnapshots(),
  (tabId, root, ci) =>
    root === null ? services.status.setCi(tabId, ci) : services.status.setRepoCi(tabId, root, ci),
  () =>
    !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
)

// opt-in Chrome DevTools Protocol endpoint for scripted E2E checks; inert
// unless the env var is set, so normal runs are unaffected. Must be set before
// the app is ready.
if (process.env['CLAUDE_TERM_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['CLAUDE_TERM_DEBUG_PORT'])
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    // detached docs/settings windows would otherwise keep the app alive after
    // the main window is gone (window-all-closed never fires)
    closeAllDocsWindows()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('nl.mendrix.claude-term')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Warm the login-shell env before the first tab spawns (also surfaces a
  // missing `claude` binary early instead of on first tab creation).
  void loginShellEnv()

  await services.status.start()
  registerIpc(services, () => mainWindow)
  createWindow()
  ciPoller.start()

  // Background auto-update: check on launch + daily, download silently, and let
  // the user install on their say-so (renderer pill → 'update:install'). The
  // install quits + relaunches; the normal session restore reopens the tabs and
  // resumes/reattaches their Claude sessions.
  setupUpdater(() => mainWindow)
  ipcMain.handle('update:install', () => installUpdate(() => mainWindow, prepareUpdateQuit))

  // Native menu with a manual "Check for Updates…" item (app menu on macOS,
  // Help menu elsewhere) alongside the standard Edit/View/Window roles.
  installAppMenu(
    () => void checkForUpdatesInteractive(() => mainWindow, prepareUpdateQuit),
    (section) => mainWindow?.webContents.send('help:show', section)
  )

  // First-run: offer to install the global activity-logging hook (feeds the
  // 🕐 Activity hours view). Idempotent + merge-only; never blocks startup.
  void ensureActivityHook(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Set when quitting to install an update: the user already consented via the
// update prompt, so skip the normal "quit?" / background-agent dialogs and let
// the quit proceed straight into the installer. Shutdown is awaited *before*
// autoUpdater.quitAndInstall — its quit must not be preventDefault'ed, or the
// staged install can be dropped.
let updateQuit = false
async function prepareUpdateQuit(): Promise<void> {
  updateQuit = true
  await shutdown()
}

let quitConfirmed = false
app.on('before-quit', (e) => {
  if (quitConfirmed || updateQuit) return
  // No window (closed before quit) or no Claude session ever ran → nothing to
  // ask, but the ptys still need draining before the quit may proceed.
  if (
    !mainWindow ||
    (services.status.activeClaudeCount() === 0 && services.status.seenSessionIds().length === 0)
  ) {
    e.preventDefault()
    finishQuit()
    return
  }
  // Otherwise defer: we may need to look up daemon background agents (async).
  e.preventDefault()
  void confirmQuit()
})

function finishQuit(stopAgents: LiveAgent[] = []): void {
  quitConfirmed = true
  // Stop our daemon background agents (best-effort) alongside shutdown.
  const stop = Promise.all(stopAgents.map((a) => stopBackgroundAgent(a.id ?? a.sessionId)))
  void Promise.allSettled([shutdown(), stop]).then(() => app.quit())
}

async function confirmQuit(): Promise<void> {
  const win = mainWindow
  if (!win) return finishQuit()

  // Background agents dispatched from our tabs keep running after we quit (they
  // live under the Claude daemon, not our PTYs). Offer to stop them or leave
  // them (they re-attach on next launch).
  let ownAgents: LiveAgent[] = []
  try {
    ownAgents = await findOwnBackgroundAgents(services.status.seenSessionIds())
  } catch {
    /* best effort — treat as none */
  }
  if (!mainWindow) return

  if (ownAgents.length > 0) {
    const n = ownAgents.length
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Kill everything', 'Quit, leave running'],
      defaultId: 2,
      cancelId: 0,
      message: `${n} background agent${n > 1 ? 's are' : ' is'} running independently of claude-term.`,
      detail:
        '“Kill everything” stops them now (their conversations are kept — resume later). ' +
        '“Quit, leave running” lets them keep working; they re-attach next launch.'
    })
    if (choice === 0) return // Cancel: stay open, keep everything running
    finishQuit(choice === 1 ? ownAgents : [])
    return
  }

  // No daemon agents — just the tabs' own sessions, which stop on quit but
  // resume from transcript next launch. Confirm (busy sessions guarded harder).
  const activeCount = services.status.activeClaudeCount()
  if (activeCount === 0) return finishQuit()
  const busyN = services.status.busyCount()
  const busy = busyN > 0
  const choice = dialog.showMessageBoxSync(win, {
    type: busy ? 'warning' : 'question',
    buttons: busy ? ['Quit anyway', 'Keep working'] : ['Quit', 'Cancel'],
    defaultId: busy ? 1 : 0,
    cancelId: 1,
    message: busy
      ? `${busyN} Claude session${busyN > 1 ? 's are' : ' is'} still working. Quit anyway?`
      : 'Quit claude-term?',
    detail: busy
      ? "Quitting stops the current turn — that unfinished work is lost, but the conversation resumes next launch. Choose “Keep working” to leave the app open until it's done."
      : `${activeCount} Claude session${activeCount > 1 ? 's' : ''} will close and resume next launch.`
  })
  if (choice === 0) finishQuit()
}

// Kill the ptys and wait for node-pty to deliver their exit callbacks before
// the quit proceeds: an exit callback landing during Node teardown aborts the
// process (SIGABRT in pty.node's ThreadSafeFunction). Idempotent — the quit
// path can be entered more than once (window close + ⌘Q, update install).
let shutdownDone: Promise<void> | null = null
function shutdown(): Promise<void> {
  shutdownDone ??= (async () => {
    ciPoller.stop()
    // Hand every held prompt back to its session before anything else: a parked
    // hook waits on us for minutes, and a session killed mid-wait would sit
    // there with a dialog nobody answered.
    services.parked.releaseAll('shutdown')
    // Freeze *first*: killing the PTYs makes every tab report its Claude session
    // gone, and those updates would otherwise reach the renderer before its final
    // save — persisting live conversations as "no session" (see StatusServer.freeze).
    services.status.freeze()
    await services.ptys.disposeAll()
    services.status.stop()
    // release the refs pinning this run's turn checkpoints — they are a
    // session's undo history, not something to leave behind in the repo
    services.checkpoints.forgetAll()
  })()
  return shutdownDone
}

app.on('window-all-closed', () => {
  app.quit()
})
