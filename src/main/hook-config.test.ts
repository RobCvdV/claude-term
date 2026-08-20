import { describe, expect, it } from 'vitest'
import {
  buildHooks,
  DECIDING_TIMEOUT_S,
  REPORTING_EVENTS,
  REPORTING_TIMEOUT_S
} from './hook-config'

const URL = 'http://127.0.0.1:1234/hook?tab=t1&token=abc'

describe('buildHooks', () => {
  const hooks = buildHooks(URL) as Record<
    string,
    { matcher?: string; hooks: { type: string; url: string; timeout: number }[] }[]
  >

  it('registers every reporting event on a short timeout', () => {
    for (const event of REPORTING_EVENTS) {
      expect(hooks[event][0].hooks[0]).toEqual({
        type: 'http',
        url: URL,
        timeout: REPORTING_TIMEOUT_S
      })
    }
  })

  it('gives the deciding hooks room to wait for a human', () => {
    expect(hooks.PermissionRequest[0].hooks[0].timeout).toBe(DECIDING_TIMEOUT_S)
    expect(hooks.PreToolUse[0].hooks[0].timeout).toBe(DECIDING_TIMEOUT_S)
  })

  it('scopes PreToolUse to the tools whose answer is content, not a verdict', () => {
    expect(hooks.PreToolUse[0].matcher).toBe('AskUserQuestion|ExitPlanMode')
    // parking every tool call would stall the session
    expect(hooks.PermissionRequest[0].matcher).toBeUndefined()
  })

  it('leaves Notification unregistered — it also fires after Stop', () => {
    expect(hooks.Notification).toBeUndefined()
  })
})
