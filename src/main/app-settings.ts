import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings, AppSettingsPatch } from '../shared/types'
import { mergeSettings, SETTINGS_DEFAULTS } from '../shared/app-settings-defaults'

let current: AppSettings | null = null
const listeners = new Set<(s: AppSettings) => void>()

const file = (): string => join(app.getPath('userData'), 'app-settings.json')

export function appSettings(): AppSettings {
  if (!current) {
    try {
      current = mergeSettings(
        SETTINGS_DEFAULTS,
        JSON.parse(readFileSync(file(), 'utf8')) as AppSettingsPatch
      )
    } catch {
      current = mergeSettings(SETTINGS_DEFAULTS, {})
    }
  }
  return current
}

export function setAppSettings(patch: AppSettingsPatch): AppSettings {
  current = mergeSettings(appSettings(), patch)
  try {
    writeFileSync(file(), JSON.stringify(current, null, 2))
  } catch {
    /* kept for this run */
  }
  for (const fn of listeners) fn(current)
  return current
}

export function onAppSettings(fn: (s: AppSettings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
