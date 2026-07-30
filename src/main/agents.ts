import { execFile } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loginShellEnv, resolveClaudePath } from './shell-env'

/** `claude agents --json` has to cold-start the daemon on the first call after a
 *  reboot, which takes well over the couple of hundred ms a warm call needs. */
const AGENTS_TIMEOUT_MS = 15_000
/** Restoring N tabs asks about N session ids in a burst; one listing serves all. */
const AGENTS_CACHE_MS = 2_000

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
let agentsCache: { at: number; agents: LiveAgent[] } | null = null

export async function listLiveAgents(fresh = false): Promise<LiveAgent[]> {
  if (!fresh && agentsCache && Date.now() - agentsCache.at < AGENTS_CACHE_MS) {
    return agentsCache.agents
  }
  const [claude, env] = await Promise.all([resolveClaudePath(), loginShellEnv()])
  const agents = await new Promise<LiveAgent[]>((resolve) => {
    execFile(
      claude,
      ['agents', '--json'],
      { timeout: AGENTS_TIMEOUT_MS, encoding: 'utf8', env: env as NodeJS.ProcessEnv },
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
  agentsCache = { at: Date.now(), agents }
  return agents
}

/** Find a live background agent whose session id matches, if any. Interactive
 *  matches are ignored: those aren't attachable and a plain --resume handles
 *  them (or fails loudly, same as before). */
export async function findLiveBackgroundAgent(
  sessionId: string,
  fresh = false
): Promise<LiveAgent | null> {
  const agents = await listLiveAgents(fresh)
  return agents.find((a) => a.kind === 'background' && a.sessionId === sessionId) ?? null
}

/**
 * Live background agents that belong to this claude-term instance: daemon
 * agents whose session id we've seen POST to our hook/statusline server this
 * run (i.e. dispatched from inside one of our tabs). Excludes background agents
 * the user started elsewhere, and the tabs' own interactive sessions (those are
 * kind 'interactive' and die with the app anyway).
 */
export async function findOwnBackgroundAgents(
  seenSessionIds: Iterable<string>
): Promise<LiveAgent[]> {
  const seen = new Set(seenSessionIds)
  const agents = await listLiveAgents()
  return agents.filter((a) => a.kind === 'background' && seen.has(a.sessionId))
}

/**
 * The background-agent job records Claude Code keeps on disk
 * (~/.claude/jobs/<jobId>/state.json). Unlike `claude agents --json` this
 * doesn't need a running daemon, so it still answers "was this session promoted
 * to a background agent?" while the daemon is cold — the exact moment we
 * restore. Returns the job id, which is what `claude attach` wants.
 *
 * Matched on the record's own `sessionId`. NOT on `linkScanPath`: that names the
 * session the agent was *forked from* (it tracks `resumeSessionId` — verified
 * across every job record on this machine), so a tab session that merely
 * dispatched a background agent matched the sub-agent's job. Two ways that hurt:
 * warmLiveAgents then waited out its whole deadline on every launch for an id
 * the daemon will never list, and a refused resume could attach the tab to the
 * sub-agent's conversation instead of the user's own.
 */
export function findBgJobForSession(
  sessionId: string,
  jobsDir = join(homedir(), '.claude', 'jobs')
): BgJobRecord | null {
  let dirs: string[]
  try {
    dirs = readdirSync(jobsDir)
  } catch {
    return null
  }
  for (const dir of dirs) {
    try {
      const state = JSON.parse(readFileSync(join(jobsDir, dir, 'state.json'), 'utf8'))
      if (state?.sessionId === sessionId) {
        return { jobId: dir, state: typeof state?.state === 'string' ? state.state : null }
      }
    } catch {
      /* no/unreadable record for this job — keep looking */
    }
  }
  return null
}

/** A job record on disk: its id (what `claude attach` takes) and last state. */
export interface BgJobRecord {
  jobId: string
  state: string | null
}

/** States in which the daemon no longer keeps the agent — it drops out of
 *  `claude agents` and the session is an ordinary `--resume` again. */
const RELEASED_JOB_STATES = ['stopped', 'failed']

/**
 * Wait until the daemon can actually answer for the sessions we're about to
 * restore. The daemon is cold after a reboot and starts hosting its recorded
 * background agents only a beat after the first `claude agents` call, so a
 * single early listing reports nothing — we'd then `--resume` a session the
 * daemon is in the middle of claiming, which it refuses ("currently running as
 * a background agent") and the tab is left as a bare shell.
 *
 * Only sessions the daemon should still own (a job record on disk that isn't
 * stopped/failed) are waited for — a released one never appears, so waiting on
 * it would just delay every launch. Bounded either way: the daemon can take
 * minutes to materialise everything, which is why a refused resume is also
 * recovered from directly (see PtyManager.watchBgRefusal).
 */
export async function warmLiveAgents(sessionIds: string[], deadlineMs = 4_000): Promise<void> {
  const expected = sessionIds.filter((id) => {
    const job = findBgJobForSession(id)
    return job && !RELEASED_JOB_STATES.includes(job.state ?? '')
  })
  const started = Date.now()
  // always list once: it cold-starts the daemon and primes the cache that the
  // per-tab revive decisions then read
  let agents = await listLiveAgents(true)
  if (expected.length === 0) return
  const listed = (): boolean => expected.every((id) => agents.some((a) => a.sessionId === id))
  while (!listed() && Date.now() - started < deadlineMs) {
    await new Promise((r) => setTimeout(r, 500))
    agents = await listLiveAgents(true)
  }
}

/** How a persisted session id should be brought back in a fresh tab. */
export type ReviveMode = { mode: 'attach'; jobId: string } | { mode: 'resume' } | { mode: 'shell' }

/**
 * Decide how to revive a persisted session. A live daemon-managed background
 * agent must be attached (`--resume` refuses it); an ordinary conversation with
 * a transcript is resumed; anything else gets a plain shell rather than a tab
 * full of "No conversation found".
 */
export async function resolveRevive(sessionId: string): Promise<ReviveMode> {
  const bg = await findLiveBackgroundAgent(sessionId)
  if (bg) return { mode: 'attach', jobId: bg.id ?? bg.sessionId }
  if (transcriptExists(sessionId)) return { mode: 'resume' }
  return { mode: 'shell' }
}

/**
 * Job id to attach to after `--resume` was refused because the session is
 * running as a background agent. The daemon is demonstrably up by then (it just
 * refused us), so ask it first and fall back to the on-disk job records.
 */
export async function jobIdForRefusedResume(sessionId: string): Promise<string | null> {
  const bg = await findLiveBackgroundAgent(sessionId, true)
  return bg?.id ?? bg?.sessionId ?? findBgJobForSession(sessionId)?.jobId ?? null
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
