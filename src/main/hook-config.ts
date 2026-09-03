import type { DecidingHook } from 'claude-term-protocol'

/**
 * Hooks that only report — the app maps them to a tab's activity state and
 * answers instantly. Note `Notification` is deliberately absent: it also fires
 * after `Stop` as a "waiting for you" ping, which left tabs stuck on
 * needs-attention.
 */
export const REPORTING_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  // A tool finishing means the turn is running again — the first signal after a
  // permission prompt is answered, so the renderer can take focus back.
  'PostToolUse',
  'Stop',
  // MCP-only: a server asking the user something mid-tool-call. It is NOT the
  // AskUserQuestion path (see docs/companion-hook-protocol.md).
  'Elicitation',
  'SessionEnd'
] as const

/**
 * Hooks whose response decides a prompt, so the app may hold one open while a
 * companion device answers. `PreToolUse` is matcher-scoped because parking every
 * tool call would stall the session; the two named tools are the only ones whose
 * answer is *content* rather than a verdict.
 */
export const DECIDING_HOOKS: { event: DecidingHook; matcher?: string }[] = [
  { event: 'PermissionRequest' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode' }
]

/** Reporting hooks answer at once, so they stay on a short leash. */
export const REPORTING_TIMEOUT_S = 5
/** A parked prompt waits for a human. The CLI's own ceiling is 600s. */
export const DECIDING_TIMEOUT_S = 600

/**
 * The `hooks` block of the per-session `--settings` overlay. Pure so it can be
 * asserted in tests without Electron.
 */
export function buildHooks(hookUrl: string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const event of REPORTING_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'http', url: hookUrl, timeout: REPORTING_TIMEOUT_S }] }]
  }
  for (const { event, matcher } of DECIDING_HOOKS) {
    hooks[event] = [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'http', url: hookUrl, timeout: DECIDING_TIMEOUT_S }]
      }
    ]
  }
  return hooks
}
