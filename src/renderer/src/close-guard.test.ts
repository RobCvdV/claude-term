import { describe, expect, it } from 'vitest'
import { closeTabConfirmMessage } from './close-guard'
import type { TabStatus } from '../../shared/types'

const status = (overrides: Partial<TabStatus>): TabStatus => ({
  tabId: 'tab-1',
  claudeActive: false,
  activity: 'idle',
  busySince: null,
  sessionId: null,
  exitCode: null,
  cwd: '/repo',
  addedDirs: [],
  payload: null,
  git: null,
  ...overrides
})

describe('closeTabConfirmMessage', () => {
  it('closes plain shell tabs silently', () => {
    expect(closeTabConfirmMessage(status({}))).toBeNull()
    expect(closeTabConfirmMessage(null)).toBeNull()
    expect(closeTabConfirmMessage(undefined)).toBeNull()
  })

  it('closes a tab whose session already ended silently', () => {
    expect(closeTabConfirmMessage(status({ claudeActive: false, sessionId: 'sess-1' }))).toBeNull()
  })

  it('confirms before closing a busy session', () => {
    expect(closeTabConfirmMessage(status({ claudeActive: true, activity: 'busy' }))).toMatch(
      /WORKING/
    )
  })

  // The regression: ⌘W (or an ×-misclick) on an idle-but-live session killed
  // the claude process instantly, with no confirmation.
  it('confirms before closing an idle live session', () => {
    const msg = closeTabConfirmMessage(status({ claudeActive: true, activity: 'idle' }))
    expect(msg).toMatch(/running in this tab/)
    expect(msg).toMatch(/resume/)
  })
})
