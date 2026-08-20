import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** Claude Code's own per-checkout permission file — where "don't ask again" goes. */
export const CLAUDE_SETTINGS_FILE = join('.claude', 'settings.local.json')

/**
 * Commands where the first word alone says too little to be worth a rule:
 * `git *` would hand over `git push --force`, so the rule names the subcommand.
 */
const SUBCOMMAND_TOOLS = new Set([
  'git',
  'gh',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'brew',
  'pip',
  'pip3',
  'poetry',
  'terraform',
  'aws',
  'gcloud',
  'systemctl',
  'apt',
  'apt-get',
  'dotnet',
  'mvn',
  'gradle'
])

/**
 * Shell syntax that makes a command more than the thing it appears to be.
 * A prefix rule derived from `mkdir a && rm -rf b` would be a licence to run the
 * second half too, so anything with these gets no suggestion at all.
 */
export function hasShellOperator(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if ('&|;<>`()$\n'.includes(ch)) return true
  }
  return false
}

/**
 * A rule that would cover this command and its obvious siblings, or null when
 * there isn't one worth offering.
 *
 * Only Bash gets a suggestion. A rule for a file tool would have to guess at a
 * path glob, and guessing wrong grants more than the user meant — so those are
 * answered once and asked again next time, which is the safe direction to err.
 */
export function suggestRule(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName !== 'Bash') return null
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : ''
  if (!command || hasShellOperator(command)) return null

  const words = command.split(/\s+/)
  const head = words[0]
  if (!head || head.startsWith('-')) return null

  const parts = [head]
  if (SUBCOMMAND_TOOLS.has(head)) {
    const second = words[1]
    // a flag is not a subcommand, and without one there is nothing to narrow to
    if (!second || second.startsWith('-')) return null
    parts.push(second)
  }
  const prefix = parts.join(' ')
  return words.length > parts.length ? `Bash(${prefix} *)` : `Bash(${prefix})`
}

interface ClaudeSettings {
  permissions?: { allow?: unknown }
  [key: string]: unknown
}

/**
 * Add `rule` to the project's Claude Code allow list, the same file its own
 * "don't ask again" writes to. Unknown keys ride along untouched, and an
 * unparsable file is left alone rather than replaced with our idea of it —
 * these files are frequently hand-edited.
 *
 * Returns false if nothing was written, including when the rule was already there.
 */
export function addAllowRule(cwd: string, rule: string): boolean {
  const path = join(cwd, CLAUDE_SETTINGS_FILE)
  let settings: ClaudeSettings = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      settings = parsed as ClaudeSettings
    } catch {
      return false
    }
  }
  const permissions = (
    settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {}
  ) as { allow?: unknown }
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : []
  if (allow.includes(rule)) return false
  allow.push(rule)

  const next: ClaudeSettings = { ...settings, permissions: { ...permissions, allow } }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}
