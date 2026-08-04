import type { TabStatus } from '../../shared/types'

/**
 * Confirmation to show before closing a tab, or null to close silently.
 * Any live claude session guards the close — not just a busy one: closing
 * kills the claude process instantly (⌘W or an ×-misclick), and an idle
 * session with a long conversation is just as valuable as a working one.
 */
export function closeTabConfirmMessage(status: TabStatus | null | undefined): string | null {
  if (!status?.claudeActive) return null
  return status.activity === 'busy'
    ? 'A claude session is still WORKING in this tab. Close it?\n\nThe conversation can be resumed later (claude --resume).'
    : 'A claude session is running in this tab. Close it?\n\nThe conversation can be resumed later (claude --resume).'
}
