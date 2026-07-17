import { app } from 'electron'
import { chmodSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
  'PermissionRequest',
  'Elicitation'
]

let forwarderPath: string | null = null

/**
 * Packaged apps can't exec scripts from inside app.asar, so install the
 * forwarder into userData at startup (idempotent) and reference it there.
 */
export function installForwarder(): string {
  if (forwarderPath) return forwarderPath
  const source = join(__dirname, '../../resources/statusline-forwarder.sh')
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'statusline-forwarder.sh')
  copyFileSync(source, dest)
  chmodSync(dest, 0o755)
  forwarderPath = dest
  return dest
}

/**
 * Per-session settings passed via `claude --settings '<json>'`.
 * Never touches ~/.claude/settings.json: the statusLine is displaced for
 * this session only (forwarder POSTs the JSON to us and prints nothing),
 * and http hooks merge with — not replace — the user's own hooks.
 */
export function buildSettingsOverlay(port: number, tabId: string, token: string): string {
  const hookUrl = (path: string): string =>
    `http://127.0.0.1:${port}/${path}?tab=${tabId}&token=${token}`
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'http', url: hookUrl('hook'), timeout: 5 }] }]
  }
  return JSON.stringify({
    // quoted: userData is under "Application Support" (path contains a space)
    // and the statusLine command string is executed through a shell
    statusLine: { type: 'command', command: `'${installForwarder()}'` },
    hooks
  })
}
