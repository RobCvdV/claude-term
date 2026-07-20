import { app, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createServices, registerIpc } from './ipc'
import { loginShellEnv } from './shell-env'

// Redirect userData (session.json, zdotdir, forwarder) to an isolated dir when
// asked — lets an E2E run restore a crafted session without touching the real
// profile. Must happen before anything reads app.getPath('userData'). Inert
// unless the env var is set, like CLAUDE_TERM_DEBUG_PORT / _DEFAULT_CWD.
if (process.env['CLAUDE_TERM_USER_DATA_DIR']) {
  app.setPath('userData', process.env['CLAUDE_TERM_USER_DATA_DIR'] as string)
}

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitConfirmed = false
app.on('before-quit', (e) => {
  if (quitConfirmed || !mainWindow) return
  const activeCount = services.status.activeClaudeCount()
  // Nothing running in a tab — quit silently. (Any sessions the user promoted
  // to daemon-managed background agents keep running independently of the app
  // and are re-attached on next launch; we deliberately don't kill those.)
  if (activeCount === 0) {
    shutdown()
    return
  }
  e.preventDefault()
  // A closed session isn't lost — its conversation resumes on next launch. The
  // only cost of quitting mid-turn is the *unfinished* turn. There's no way to
  // keep a session running after the app closes (Claude Code doesn't expose
  // promoting a live interactive session to a background agent), so the honest
  // choice is stop-now vs stay-open-to-let-it-finish.
  const busyN = services.status.busyCount()
  const busy = busyN > 0
  const message = busy
    ? `${busyN} Claude session${busyN > 1 ? 's are' : ' is'} still working. Quit anyway?`
    : 'Quit claude-term?'
  const detail = busy
    ? "Quitting stops the current turn — that unfinished work is lost, but the conversation resumes next launch. Choose “Keep working” to leave the app open until it's done."
    : `${activeCount} Claude session${activeCount > 1 ? 's' : ''} will close and resume next launch.`
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: busy ? 'warning' : 'question',
    // a busy session is worth guarding (default = don't quit); an idle one is
    // routine (default Quit, so Enter just quits) — either way the user chooses.
    buttons: busy ? ['Quit anyway', 'Keep working'] : ['Quit', 'Cancel'],
    defaultId: busy ? 1 : 0,
    cancelId: 1,
    message,
    detail
  })
  if (choice === 0) {
    quitConfirmed = true
    shutdown()
    app.quit()
  }
})

function shutdown(): void {
  services.ptys.killAll()
  services.status.stop()
}

app.on('window-all-closed', () => {
  app.quit()
})
