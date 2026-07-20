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
 * Live background agents that belong to this claude-term instance: daemon
 * agents whose session id we've seen POST to our hook/statusline server this
 * run (i.e. dispatched from inside one of our tabs). Excludes background agents
 * the user started elsewhere, and the tabs' own interactive sessions (those are
 * kind 'interactive' and die with the app anyway).
 */
export async function findOwnBackgroundAgents(seenSessionIds: Iterable<string>): Promise<LiveAgent[]> {
  const seen = new Set(seenSessionIds)
  const agents = await listLiveAgents()
  return agents.filter((a) => a.kind === 'background' && seen.has(a.sessionId))
}

/**
 * Stop a background agent via `claude stop <id>` (keeps its conversation; it can
 * be re-attached later). Resolves true on success. Best-effort, bounded time.
 */
export async function stopBackgroundAgent(jobId: string): Promise<boolean> {
  const [claude, env] = await Promise.all([resolveClaudePath(), loginShellEnv()])
  return new Promise((resolve) => {
    execFile(
      claude,
      ['stop', jobId],
      { timeout: 8_000, encoding: 'utf8', env: env as NodeJS.ProcessEnv },
      (err) => resolve(!err)
    )
  })
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
