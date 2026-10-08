import { app } from 'electron'
import { appendFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'

const MAX_BYTES = 5 * 1024 * 1024

/** What happened to each prompt held for a phone, and when phones came and went. */
export function logCompanion(event: string, data: object = {}): void {
  const file = join(app.getPath('userData'), 'companion.log')
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES)
      renameSync(file, `${file}.1`)
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n')
  } catch {
    /* diagnostics only */
  }
}
