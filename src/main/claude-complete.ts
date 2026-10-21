import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ClaudeTask, CompletionRequest, CompletionResult, EditRequest } from '../shared/types'
import { appSettings } from './app-settings'
import { claudeConfigDirIn } from './claude-dir'
import {
  cleanCompletion,
  cleanEdit,
  COMPLETION_SYSTEM_PROMPT,
  completionPrompt,
  EDIT_SYSTEM_PROMPT,
  editPrompt
} from './completion-text'
import { loginShellEnv, resolveClaudePath } from './shell-env'

/**
 * Completions and selection edits from `claude` on the user's own login (subscription). Starting
 * claude costs ~2 s of the ~3 s a one-off `claude -p` takes, so a warm
 * stream-json process per Claude account answers instead (~0.8 s): spawned
 * when a file editor opens, replaced every few completions so earlier answers
 * don't pile up in its context, and stopped when idle. Haiku, no tools, no
 * MCP, no settings or hooks, nothing saved, run outside the project.
 */

const TIMEOUT_MS = 45_000
/** completions per process before a fresh one takes over */
const USES_PER_PROCESS = 6
const IDLE_MS = 10 * 60_000

/** What one kind of request runs as: its model and system prompt. */
function taskSpec(task: ClaudeTask): { model: string; system: string } {
  return task === 'edit'
    ? { model: appSettings().claudeEditModel, system: EDIT_SYSTEM_PROMPT }
    : { model: 'haiku', system: COMPLETION_SYSTEM_PROMPT }
}

function baseArgs(task: ClaudeTask): string[] {
  const { model, system } = taskSpec(task)
  return [
    '-p',
    '--model',
    model,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--system-prompt',
    system
  ]
}

function workDir(): string {
  const cwd = join(tmpdir(), 'claude-term-complete')
  mkdirSync(cwd, { recursive: true })
  return cwd
}

async function claudeEnv(configDir: string): Promise<NodeJS.ProcessEnv> {
  return { ...(await loginShellEnv()), CLAUDE_CONFIG_DIR: configDir }
}

interface Waiter {
  resolve: (text: string) => void
  reject: (err: Error) => void
}

/** One long-running `claude -p --input-format stream-json` answering in turn. */
class WarmClaude {
  private buf = ''
  private waiter: Waiter | null = null
  private chain: Promise<unknown> = Promise.resolve()
  uses = 0
  dead = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (d: Buffer) => this.onData(d.toString()))
    child.on('close', () => this.fail(new Error('claude stopped')))
    child.on('error', (e) => this.fail(e))
  }

  ask(prompt: string): Promise<string> {
    this.uses++
    const run = this.chain.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (this.dead) return reject(new Error('claude stopped'))
          this.waiter = { resolve, reject }
          this.child.stdin.write(
            JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'
          )
        })
    )
    this.chain = run.catch(() => undefined)
    return run
  }

  kill(): void {
    this.dead = true
    this.child.kill()
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      let msg: { type?: string; result?: string; is_error?: boolean }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type !== 'result' || !this.waiter) continue
      const w = this.waiter
      this.waiter = null
      if (msg.is_error) w.reject(new Error(msg.result || 'claude error'))
      else w.resolve(msg.result ?? '')
    }
  }

  private fail(err: Error): void {
    this.dead = true
    this.waiter?.reject(err)
    this.waiter = null
  }
}

interface Slot {
  warm: WarmClaude | null
  /** started one completion before `warm` retires, so the swap costs nothing */
  next: Promise<WarmClaude> | null
  idle: NodeJS.Timeout | null
}

const slots = new Map<string, Slot>()

/** Warm processes are kept per task, model and Claude account. */
const slotKey = (task: ClaudeTask, configDir: string): string =>
  `${task}|${taskSpec(task).model}|${configDir}`

async function spawnWarm(task: ClaudeTask, configDir: string): Promise<WarmClaude> {
  const [claude, env] = await Promise.all([resolveClaudePath(), claudeEnv(configDir)])
  const child = spawn(
    claude,
    [
      ...baseArgs(task),
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose'
    ],
    { cwd: workDir(), env }
  )
  return new WarmClaude(child)
}

/** The account's warm process, started if there is none (or it died). */
async function warmFor(task: ClaudeTask, configDir: string): Promise<WarmClaude> {
  const key = slotKey(task, configDir)
  const slot = slots.get(key) ?? { warm: null, next: null, idle: null }
  slots.set(key, slot)
  if (!slot.warm || slot.warm.dead) {
    const next = slot.next
    slot.next = null
    slot.warm = (next && (await next.catch(() => null))) || (await spawnWarm(task, configDir))
    if (slot.warm.dead) slot.warm = await spawnWarm(task, configDir)
  }
  if (slot.idle) clearTimeout(slot.idle)
  slot.idle = setTimeout(() => {
    slot.warm?.kill()
    slot.warm = null
    void slot.next?.then((w) => w.kill())
    slot.next = null
  }, IDLE_MS)
  return slot.warm
}

/** Start a warm process for `task` on the account of `path`, ahead of the request. */
export function warmUpClaude(task: ClaudeTask, path: string): void {
  void claudeConfigDirIn(dirname(path))
    .then((configDir) => warmFor(task, configDir))
    .catch(() => undefined)
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Claude took too long')), TIMEOUT_MS)
    )
  ])
}

/** One answer from the warm process for `task`, falling back to a one-off run. */
async function askClaude(
  task: ClaudeTask,
  path: string,
  prompt: string
): Promise<CompletionResult> {
  const configDir = await claudeConfigDirIn(dirname(path))
  const key = slotKey(task, configDir)
  try {
    const warm = await warmFor(task, configDir)
    const slot = slots.get(key)
    // the replacement starts warming one request ahead
    if (slot && !slot.next && warm.uses >= USES_PER_PROCESS - 2) {
      slot.next = spawnWarm(task, configDir)
      slot.next.catch(() => undefined)
    }
    const reply = await withTimeout(warm.ask(prompt))
    if (warm.uses >= USES_PER_PROCESS && slot) {
      warm.kill()
      slot.warm = null
    }
    return { ok: true, text: reply }
  } catch {
    slots.get(key)?.warm?.kill()
    return oneShot(task, configDir, prompt)
  }
}

export async function completeWithClaude(req: CompletionRequest): Promise<CompletionResult> {
  const res = await askClaude(
    'complete',
    req.path,
    completionPrompt(req.path, req.prefix, req.suffix)
  )
  return res.ok ? { ok: true, text: cleanCompletion(res.text, req.prefix) } : res
}

export async function editWithClaude(req: EditRequest): Promise<CompletionResult> {
  const res = await askClaude(
    'edit',
    req.path,
    editPrompt(req.path, req.before, req.selection, req.after, req.instruction)
  )
  return res.ok ? { ok: true, text: cleanEdit(res.text, req.selection) } : res
}

/** Fallback: a plain `claude -p` for this one request. */
async function oneShot(
  task: ClaudeTask,
  configDir: string,
  prompt: string
): Promise<CompletionResult> {
  const [claude, env] = await Promise.all([resolveClaudePath(), claudeEnv(configDir)])
  return new Promise((resolve) => {
    const child = spawn(claude, baseArgs(task), { cwd: workDir(), env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'Claude took too long' })
    }, TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({
          ok: false,
          error: (err || out).trim().split('\n').pop() || `claude exited ${code}`
        })
        return
      }
      resolve({ ok: true, text: out })
    })
    child.stdin.end(prompt)
  })
}

/** Stop every warm process — the app is quitting. */
export function stopCompletionWorkers(): void {
  for (const slot of slots.values()) {
    slot.warm?.kill()
    void slot.next?.then((w) => w.kill())
    if (slot.idle) clearTimeout(slot.idle)
  }
  slots.clear()
}
