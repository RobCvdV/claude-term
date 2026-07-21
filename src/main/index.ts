import { app, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createServices, registerIpc } from './ipc'
import { ensureActivityHook } from './activity-hook-install'
import { loginShellEnv } from './shell-env'
import { findOwnBackgroundAgents, stopBackgroundAgent, type LiveAgent } from './agents'

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
  mainWindow.on('closed', () => (mainWindow = null))

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

  // First-run: offer to install the global activity-logging hook (feeds the
  // 🕐 Activity hours view). Idempotent + merge-only; never blocks startup.
  void ensureActivityHook(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitConfirmed = false
app.on('before-quit', (e) => {
  if (quitConfirmed || !mainWindow) return
  // Fast path: no Claude session ever ran this session → nothing to guard.
  if (
    services.status.activeClaudeCount() === 0 &&
    services.status.seenSessionIds().length === 0
  ) {
    shutdown()
    return
  }
  // Otherwise defer: we may need to look up daemon background agents (async).
  e.preventDefault()
  void confirmQuit()
})

function finishQuit(stopAgents: LiveAgent[] = []): void {
  quitConfirmed = true
  shutdown()
  if (stopAgents.length === 0) {
    app.quit()
    return
  }
  // Stop our daemon background agents (best-effort) before we go.
  void Promise.all(stopAgents.map((a) => stopBackgroundAgent(a.id ?? a.sessionId))).finally(() =>
    app.quit()
  )
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

function shutdown(): void {
  services.ptys.killAll()
  services.status.stop()
}

app.on('window-all-closed', () => {
  app.quit()
})
