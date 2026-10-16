import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createServices, registerIpc, type IpcHandles } from './ipc'
import { ensureActivityHook } from './activity-hook-install'
import { loginShellEnv } from './shell-env'
import { findOwnBackgroundAgents, stopBackgroundAgent, type LiveAgent } from './agents'
import { setupUpdater, installUpdate, checkForUpdatesInteractive, pendingUpdate } from './updater'
import { installAppMenu, installCycleKey, installZoomKeys } from './menu'
import { TerminalWindows } from './terminal-windows'
import { windowsOf } from './window-order'
import { onAppSettings } from './app-settings'
import type { WindowBounds } from '../shared/types'
import { closeAllDocsWindows } from './docs-window'
import { CiPoller } from './ci-status'
import { setTicketFetcher } from './ticket-status'
import { fetchTicketStatus } from './jira-client'

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
  const win = windows.focusedOrPrimary()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

const windows = new TerminalWindows()
const services = createServices(windows)
/** the focused terminal window, else the main one — for dialogs and menu actions */
const frontWindow = (): BrowserWindow | null => windows.focusedOrPrimary()

// Live CI state per repo+branch (Jenkins / Actions / CircleCI) — polls only
// while the window is actually on screen; results ride status:update.
const ciPoller = new CiPoller(
  () => services.status.allSnapshots(),
  (tabId, root, ci) =>
    root === null ? services.status.setCi(tabId, ci) : services.status.setRepoCi(tabId, root, ci),
  () => windows.anyVisible()
)

setTicketFetcher(fetchTicketStatus)

// opt-in Chrome DevTools Protocol endpoint for scripted E2E checks; inert
// unless the env var is set, so normal runs are unaffected. Must be set before
// the app is ready.
if (process.env['CLAUDE_TERM_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['CLAUDE_TERM_DEBUG_PORT'])
}

app.on('browser-window-created', (_event, win) => {
  installZoomKeys(win)
  installCycleKey(win, () => windows.cycle())
})

function makeWindow(bounds: WindowBounds | undefined): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...bounds,
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

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** The windows of the saved session; a dev cwd override opens just one tab there. */
function openStartupWindows(saved: ReturnType<IpcHandles['loadSession']>): void {
  const cwd = process.env.CLAUDE_TERM_DEFAULT_CWD ?? null
  const restore = cwd ? [] : windowsOf(saved).filter((w) => w.tabs.length > 0)
  if (restore.length === 0) {
    windows.create({ mode: 'fresh', cwd })
    return
  }
  for (const w of restore) {
    windows.create(
      { mode: 'restore', session: { tabs: w.tabs, activeIndex: w.activeIndex } },
      w.bounds
    )
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('nl.mendrix.claude-term')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Awaited: it carries CLAUDE_CONFIG_DIR, which session restore reads.
  await loginShellEnv()

  await services.status.start()
  // Reuse the port a paired phone already knows, so reconnecting doesn't need
  // the QR again. Same trick as status-endpoint.json.
  await startCompanion()
  const ipc = registerIpc(services, windows)
  windows.hooks = {
    make: makeWindow,
    disposeTabs: ipc.disposeTabs,
    resendStatus: ipc.resendStatus,
    persist: ipc.writeSession,
    // detached docs/settings windows would otherwise keep the app alive after
    // the last terminal window is gone (window-all-closed never fires)
    allClosed: () => closeAllDocsWindows()
  }
  onAppSettings((s) => windows.broadcast('app:settingsChanged', s))
  ipcMain.handle('update:pending', () => pendingUpdate())
  openStartupWindows(ipc.loadSession())
  ciPoller.start()

  // Background auto-update: check on launch + daily, download silently, and let
  // the user install on their say-so (renderer pill → 'update:install'). The
  // install quits + relaunches; the normal session restore reopens the tabs and
  // resumes/reattaches their Claude sessions.
  setupUpdater((version) => windows.broadcast('update:downloaded', version))
  ipcMain.handle('update:install', () => installUpdate(frontWindow, prepareUpdateQuit))

  // Native menu with a manual "Check for Updates…" item (app menu on macOS,
  // Help menu elsewhere) alongside the standard Edit/View/Window roles.
  installAppMenu(
    () => void checkForUpdatesInteractive(frontWindow, prepareUpdateQuit),
    (section) => frontWindow()?.webContents.send('help:show', section),
    {
      newWindow: () => windows.createFresh(),
      nextWindow: () => windows.cycle(),
      moveTabToNewWindow: () => frontWindow()?.webContents.send('tabs:moveActive')
    }
  )

  // First-run: offer to install the global activity-logging hook (feeds the
  // 🕐 Activity hours view). Idempotent + merge-only; never blocks startup.
  void ensureActivityHook(frontWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createFresh()
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
  windows.quitting = true
  await shutdown()
}

let quitConfirmed = false
app.on('before-quit', (e) => {
  if (quitConfirmed || updateQuit) return
  // No window (closed before quit) or no Claude session ever ran → nothing to
  // ask, but the ptys still need draining before the quit may proceed.
  if (
    windows.count() === 0 ||
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
  windows.quitting = true
  // Stop our daemon background agents (best-effort) alongside shutdown.
  const stop = Promise.all(stopAgents.map((a) => stopBackgroundAgent(a.id ?? a.sessionId)))
  void Promise.allSettled([shutdown(), stop]).then(() => app.quit())
}

async function confirmQuit(): Promise<void> {
  const win = frontWindow()
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
  if (windows.count() === 0) return

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
const companionPortFile = (): string => join(app.getPath('userData'), 'companion-endpoint.json')

/** Reuse the port a paired phone already knows, so reconnecting needs no new QR. */
async function startCompanion(): Promise<void> {
  let preferred = 0
  try {
    const raw = JSON.parse(readFileSync(companionPortFile(), 'utf8')) as { port?: unknown }
    if (typeof raw.port === 'number') preferred = raw.port
  } catch {
    /* first run */
  }
  try {
    await services.companion.start(preferred)
  } catch (err) {
    // A companion transport that won't bind must not stop the app from opening.
    console.error('[companion] could not start:', err)
    return
  }
  if (services.companion.port !== preferred) {
    try {
      writeFileSync(companionPortFile(), JSON.stringify({ port: services.companion.port }))
    } catch {
      /* best effort */
    }
  }
}

function shutdown(): Promise<void> {
  shutdownDone ??= (async () => {
    ciPoller.stop()
    // Hand every held prompt back to its session before anything else: a parked
    // hook waits on us for minutes, and a session killed mid-wait would sit
    // there with a dialog nobody answered.
    services.parked.releaseAll('shutdown')
    services.hub.stop()
    // a screen only exists in a window that is about to be gone
    services.screens.abandonAll()
    services.companion.stop()
    services.releaseSleepBlocker()
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
