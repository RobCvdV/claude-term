import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { resolveShell, shellEnvSync } from './shell-env'

/** Claude Code's config dir: the login shell's $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(): string {
  return shellEnvSync().CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const MARK = '__CLAUDE_TERM_CFG__'
const perDir = new Map<string, Promise<string>>()

/** Pulls the marked values out of the shell's output, one per dir, in order. */
export function parseConfigDirs(stdout: string, count: number, fallback: string): string[] {
  const values = stdout
    .split('\n')
    .filter((l) => l.startsWith(MARK))
    .map((l) => l.slice(MARK.length) || fallback)
  return Array.from({ length: count }, (_, i) => values[i] ?? fallback)
}

/**
 * Resolves the config dir a claude started in each of `dirs` would use, in one
 * login shell: per-directory env (mise, direnv) can point it elsewhere.
 */
export function prefetchConfigDirs(dirs: string[]): void {
  const todo = [...new Set(dirs)].filter((d) => !perDir.has(d))
  if (todo.length === 0) return
  const batch = (async (): Promise<string[]> => {
    const shell = await resolveShell()
    const fallback = claudeConfigDir()
    const script = `for d; do (cd -- "$d" 2>/dev/null; printf '%s\\n' "${MARK}$CLAUDE_CONFIG_DIR"); done`
    return new Promise((resolve) => {
      execFile(
        shell,
        ['-ilc', script, 'claude-term', ...todo],
        { timeout: 10_000, encoding: 'utf8' },
        (_err, stdout) => resolve(parseConfigDirs(stdout ?? '', todo.length, fallback))
      )
    })
  })()
  todo.forEach((d, i) =>
    perDir.set(
      d,
      batch.then((values) => values[i])
    )
  )
}

/** The config dir for a claude started in `dir`. */
export function claudeConfigDirIn(dir: string): Promise<string> {
  prefetchConfigDirs([dir])
  return perDir.get(dir) as Promise<string>
}
