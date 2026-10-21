import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { CompletionRequest, CompletionResult } from '../shared/types'
import { claudeConfigDirIn } from './claude-dir'
import { cleanCompletion, COMPLETION_SYSTEM_PROMPT, completionPrompt } from './completion-text'
import { loginShellEnv, resolveClaudePath } from './shell-env'

const TIMEOUT_MS = 45_000

/**
 * One completion from `claude -p` on the user's own login (subscription).
 * Haiku, no tools, no MCP servers, no settings or hooks, nothing saved, and
 * run outside the project so no CLAUDE.md is read — the cursor context is all
 * it needs, and every extra costs start-up time.
 */
export async function completeWithClaude(req: CompletionRequest): Promise<CompletionResult> {
  const [claude, env, configDir] = await Promise.all([
    resolveClaudePath(),
    loginShellEnv(),
    claudeConfigDirIn(dirname(req.path))
  ])
  const cwd = join(tmpdir(), 'claude-term-complete')
  mkdirSync(cwd, { recursive: true })
  const args = [
    '-p',
    '--model',
    'haiku',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--system-prompt',
    COMPLETION_SYSTEM_PROMPT
  ]
  return new Promise((resolve) => {
    const child = spawn(claude, args, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: configDir } })
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
      resolve({ ok: true, text: cleanCompletion(out, req.prefix) })
    })
    child.stdin.end(completionPrompt(req.path, req.prefix, req.suffix))
  })
}
