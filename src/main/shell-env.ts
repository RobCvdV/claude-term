import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, delimiter } from 'path'

let cachedEnv: NodeJS.ProcessEnv | null = null
let cachedClaudePath: string | null = null

/**
 * macOS GUI apps don't inherit the login shell's PATH, so `claude`
 * (~/.local/bin) would be invisible. Capture the interactive login shell's
 * environment once and merge it over process.env.
 */
export async function loginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) return cachedEnv
  const env = await new Promise<NodeJS.ProcessEnv>((resolve) => {
    execFile(
      '/bin/zsh',
      ['-ilc', 'env'],
      { timeout: 10_000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return resolve({})
        const parsed: NodeJS.ProcessEnv = {}
        for (const line of stdout.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1)
        }
        resolve(parsed)
      }
    )
  })
  cachedEnv = { ...process.env, ...env }
  return cachedEnv
}

export async function resolveShell(): Promise<string> {
  const env = await loginShellEnv()
  return env.SHELL || '/bin/zsh'
}

export async function resolveClaudePath(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath
  const env = await loginShellEnv()
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'claude')
    if (dir && existsSync(candidate)) {
      cachedClaudePath = candidate
      return candidate
    }
  }
  const fallback = join(homedir(), '.local', 'bin', 'claude')
  cachedClaudePath = fallback
  return fallback
}
