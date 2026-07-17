import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loginShellEnv, resolveClaudePath } from './shell-env'

/** One live session as reported by `claude agents --json`. Background agents
 *  are daemon-managed and carry a short job `id`; interactive sessions don't. */
export interface LiveAgent {
  /** short job id (background agents only) — the argument `claude attach` wants */
  id?: string
  sessionId: string
  kind: 'background' | 'interactive'
  /** e.g. 'done', 'blocked' (background); may be absent for interactive */
  state?: string
  status?: string
}

/**
 * List the sessions the Claude Code daemon currently keeps alive. Used at
 * restore time to tell whether a persisted session id is a still-running
 * *background agent* (which `--resume` refuses — it must be attached instead)
 * versus an ordinary conversation we can `--resume` from its transcript.
 * Best-effort: returns [] if the CLI is missing, times out, or prints garbage.
 */
export async function listLiveAgents(): Promise<LiveAgent[]> {
  const [claude, env] = await Promise.all([resolveClaudePath(), loginShellEnv()])
  return new Promise((resolve) => {
    execFile(
      claude,
      ['agents', '--json'],
      { timeout: 5_000, encoding: 'utf8', env: env as NodeJS.ProcessEnv },
      (err, stdout) => {
        if (err) return resolve([])
        try {
          const parsed = JSON.parse(stdout)
          resolve(Array.isArray(parsed) ? (parsed as LiveAgent[]) : [])
        } catch {
          resolve([])
        }
      }
    )
  })
}

/** Find a live background agent whose session id matches, if any. Interactive
 *  matches are ignored: those aren't attachable and a plain --resume handles
 *  them (or fails loudly, same as before). */
export async function findLiveBackgroundAgent(sessionId: string): Promise<LiveAgent | null> {
  const agents = await listLiveAgents()
  return agents.find((a) => a.kind === 'background' && a.sessionId === sessionId) ?? null
}

/**
 * Whether Claude Code has a resumable transcript for this session id. Claude
 * stores transcripts at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl; the
 * cwd encoding isn't worth reproducing, so we scan the project dirs for the
 * file. A persisted id can outlive its transcript (short-lived/aborted session,
 * or Claude's retention cleanup), and `--resume` on a missing one errors "No
 * conversation found" — callers use this to fall back to a fresh shell instead.
 */
export function transcriptExists(sessionId: string): boolean {
  const projects = join(homedir(), '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(projects)
  } catch {
    return false
  }
  const file = `${sessionId}.jsonl`
  return dirs.some((d) => existsSync(join(projects, d, file)))
}
