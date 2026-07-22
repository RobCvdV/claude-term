import { app } from 'electron'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { resolveClaudePath } from './shell-env'

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
  'PermissionRequest',
  'Elicitation',
  // Fires when a tool finishes — in particular right after the user answers a
  // permission prompt and the approved tool runs. Used to hand focus back to
  // the prompt box the instant a dialog is answered (not only when the whole
  // turn ends). See status-server handleHook + App.tsx refocus logic.
  'PostToolUse'
]

let forwarderPath: string | null = null
let sessionNamerPath: string | null = null

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
 * Install the session-namer helper (see resources/session-name.sh) the same way
 * as the forwarder. The `claude` launcher calls it to derive a `--name` from the
 * tab's git branch, so sessions started here show up in the Claude app under the
 * branch name (e.g. bug/MTX-12345-broken-stuff) instead of an auto summary.
 */
export function installSessionNamer(): string {
  if (sessionNamerPath) return sessionNamerPath
  const source = join(__dirname, '../../resources/session-name.sh')
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'session-name.sh')
  copyFileSync(source, dest)
  chmodSync(dest, 0o755)
  sessionNamerPath = dest
  return dest
}

/**
 * Set up a private startup environment so that running `claude` in the tab's
 * shell transparently gets our `--settings` overlay (so its hooks + statusline
 * feed this app, which is how we detect a session starting/ending and show the
 * UI). Returns env vars to merge into the PTY.
 *
 * zsh: a private ZDOTDIR whose .zshrc sources the user's real config then
 * defines a `claude` function (a shell function beats PATH lookup, so it works
 * regardless of how the user's rc orders PATH). Other shells: a PATH shim
 * (best effort). Nothing in ~/ is modified.
 */
export async function setupClaudeLauncher(shell: string): Promise<Record<string, string>> {
  const realClaude = await resolveClaudePath()
  const namer = installSessionNamer()
  const dir = app.getPath('userData')

  if (basename(shell).includes('zsh')) {
    const zdotdir = join(dir, 'zdotdir')
    mkdirSync(zdotdir, { recursive: true })
    // .zshenv resets ZDOTDIR back to ours in case the user's config changes it,
    // so our .zshrc (with the claude function) is guaranteed to run.
    writeFileSync(
      join(zdotdir, '.zshenv'),
      `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\nexport ZDOTDIR="${zdotdir}"\n`
    )
    writeFileSync(join(zdotdir, '.zprofile'), `[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n`)
    writeFileSync(join(zdotdir, '.zlogin'), `[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"\n`)
    writeFileSync(
      join(zdotdir, '.zshrc'),
      `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\n` +
        `# claude-term: wrap claude so sessions started here light up the UI and\n` +
        `# carry the tab's branch name (via the session-namer) into the Claude app.\n` +
        `claude() {\n` +
        `  local __ctn; __ctn="$('${namer}' "$@")"\n` +
        `  if [[ -n "$__ctn" ]]; then\n` +
        `    "${realClaude}" --settings "$CLAUDE_TERM_SETTINGS" --name "$__ctn" "$@"\n` +
        `  else\n` +
        `    "${realClaude}" --settings "$CLAUDE_TERM_SETTINGS" "$@"\n` +
        `  fi\n` +
        `}\n` +
        `# claude-term: auto-restore a persisted session on launch. Only one of\n` +
        `# these vars is set, and only when restoring, so normal shells never fire.\n` +
        `# ATTACH: the session became a daemon-managed background agent; it can't\n` +
        `# be --resume'd while alive, so reconnect with 'claude attach'. This uses\n` +
        `# the real binary (not our wrapper) — attach takes no --settings.\n` +
        `if [[ -n "$CLAUDE_TERM_ATTACH" ]]; then\n` +
        `  __cta="$CLAUDE_TERM_ATTACH"; unset CLAUDE_TERM_ATTACH CLAUDE_TERM_RESUME\n` +
        `  "${realClaude}" attach "$__cta"; unset __cta\n` +
        `elif [[ -n "$CLAUDE_TERM_RESUME" ]]; then\n` +
        `  __ctr="$CLAUDE_TERM_RESUME"; unset CLAUDE_TERM_RESUME\n` +
        `  claude --resume "$__ctr"; unset __ctr\n` +
        `fi\n`
    )
    return { ZDOTDIR: zdotdir }
  }

  // fallback: PATH shim
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const shim = join(binDir, 'claude')
  writeFileSync(
    shim,
    `#!/bin/bash\n` +
      `__ctn="$('${namer}' "$@")"\n` +
      `if [ -n "$__ctn" ]; then\n` +
      `  exec "${realClaude}" --settings "$CLAUDE_TERM_SETTINGS" --name "$__ctn" "$@"\n` +
      `else\n` +
      `  exec "${realClaude}" --settings "$CLAUDE_TERM_SETTINGS" "$@"\n` +
      `fi\n`
  )
  chmodSync(shim, 0o755)
  return { CLAUDE_TERM_BIN: binDir }
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
