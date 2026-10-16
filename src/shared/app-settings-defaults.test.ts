import { describe, expect, it } from 'vitest'
import { mergeSettings, SETTINGS_DEFAULTS } from './app-settings-defaults'

describe('mergeSettings', () => {
  it('keeps the other notification switches when one changes', () => {
    const next = mergeSettings(SETTINGS_DEFAULTS, { notify: { ciFixed: false } })
    expect(next.notify.ciFixed).toBe(false)
    expect(next.notify.prApproved).toBe(true)
  })

  it('fills new keys into an older settings file', () => {
    const next = mergeSettings(SETTINGS_DEFAULTS, { tabKeysPerWindow: false })
    expect(next).toMatchObject({ tabKeysPerWindow: false, ciPolling: true, behindThreshold: 20 })
  })
})
