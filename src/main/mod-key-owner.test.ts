import { describe, expect, it } from 'vitest'
import { speaksForTab } from './mod-key-owner'

describe('speaksForTab', () => {
  it('accepts the foreground session and rejects any other', () => {
    expect(speaksForTab('fg', 'fg')).toBe(true)
    expect(speaksForTab('bg-agent', 'fg')).toBe(false)
  })

  it('accepts everything while the foreground session is unknown', () => {
    expect(speaksForTab('any', null)).toBe(true)
    expect(speaksForTab('any', undefined)).toBe(true)
  })

  it('accepts events that carry no session id', () => {
    expect(speaksForTab(undefined, 'fg')).toBe(true)
    expect(speaksForTab('', 'fg')).toBe(true)
  })
})
