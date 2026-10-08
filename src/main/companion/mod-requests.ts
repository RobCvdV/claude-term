import type { TabId } from '../../shared/types'
import type { ParkedPrompts } from './parked-prompts'

export interface ModRequestDeps {
  parked: ParkedPrompts
  /** A prompt is now held for a phone, so the tab is waiting on someone. */
  dialogOpen: (tabId: TabId) => void
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/**
 * The term-bridge mod's side of holding a dialog for a phone: `park` it, `wait`
 * (a long-poll) for a phone's answer, `close` it when the terminal answered
 * first, and `approve` the re-run of a permission that was asked again.
 */
export async function handleModRequest(
  deps: ModRequestDeps,
  tabId: TabId,
  action: string,
  body: Record<string, unknown>
): Promise<object> {
  const { parked } = deps
  switch (action) {
    case 'park': {
      const toolName = str(body.toolName)
      if (!toolName) return { id: null }
      const prompt = parked.parkForMod(tabId, {
        sessionId: str(body.session_id),
        toolName,
        input: record(body.input),
        reasked: body.reasked === true
      })
      if (prompt) deps.dialogOpen(tabId)
      return { id: prompt?.id ?? null }
    }
    case 'wait': {
      const id = str(body.id)
      return id ? parked.waitForMod(id) : { gone: true }
    }
    case 'close': {
      const id = str(body.id)
      if (id) parked.closeForMod(id)
      return {}
    }
    case 'approve': {
      const toolName = str(body.toolName)
      if (toolName) parked.approveOnce(tabId, toolName, record(body.input))
      return {}
    }
    default:
      return {}
  }
}
