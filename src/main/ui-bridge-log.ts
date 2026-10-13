import { app } from 'electron'
import { appendFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import type { TabId } from '../shared/types'

const MAX_BYTES = 5 * 1024 * 1024

/**
 * Side-by-side record of the term-bridge mod's UI events, where the app put
 * focus, and the Esc presses it sent on — for when a session ignores one.
 */
export function logUiBridge(tabId: TabId, source: 'mod' | 'focus' | 'key', data: object): void {
  const file = join(app.getPath('userData'), 'ui-bridge.log')
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES)
      renameSync(file, `${file}.1`)
    const line = { ...data, at: new Date().toISOString(), tab: tabId.slice(0, 8), source }
    appendFileSync(file, JSON.stringify(line) + '\n')
  } catch {
    /* diagnostics only */
  }
}
