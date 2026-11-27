import { execFile } from 'child_process'
import { Notification } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loginShellEnv } from './shell-env'

/** Where Claudia (ai-face) lives; CLAUDIA_DIR overrides it. */
const claudiaDir = (): string => process.env['CLAUDIA_DIR'] ?? join(homedir(), 'Dev', 'ai-face')

/** Her own (re)start script, when she is on this Mac. */
export function claudiaScript(): string | null {
  const script = join(claudiaDir(), 'scripts', 'summon.sh')
  return existsSync(script) ? script : null
}

/**
 * Starts Claudia, restarting her if she is up, or sends her away. She runs as
 * a child of this app, so macOS lets her use the microphone it was given.
 * Resolves to what the script said.
 */
export async function summonClaudia(away = false): Promise<string> {
  const script = claudiaScript()
  if (!script) return `Claudia isn't here: no ${join(claudiaDir(), 'scripts', 'summon.sh')}`
  const env = await loginShellEnv()
  return new Promise((resolve) =>
    execFile(script, away ? ['stop'] : [], { env, timeout: 30_000 }, (err, stdout) =>
      resolve(err ? `Claudia didn't come: ${err.message}` : stdout.trim())
    )
  )
}

/** For the menu: summon or send her away, and say how it went. */
export async function tellClaudia(away: boolean): Promise<void> {
  new Notification({ title: 'Claudia', body: await summonClaudia(away) }).show()
}
