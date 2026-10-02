import { describe, expect, it, vi } from 'vitest'
import { onUiKeys, ownerOfKeysState, setUiKeys, uiKeysOwner } from './ui-keys'

describe('ownerOfKeysState', () => {
  it('gives the keys to the TUI for a dialog or a missing input line', () => {
    expect(ownerOfKeysState('dialog')).toBe('tui')
    expect(ownerOfKeysState('no_composer')).toBe('tui')
  })

  it('gives them to the prompt at the plain input line', () => {
    expect(ownerOfKeysState('prompt')).toBe('prompt')
  })

  it("can't tell while the TUI's own input holds text, or without a mod", () => {
    expect(ownerOfKeysState('typing')).toBe(null)
    expect(ownerOfKeysState('timeout')).toBe(null)
    expect(ownerOfKeysState(null)).toBe(null)
  })
})

describe('setUiKeys', () => {
  it('notifies only when the owner changes', () => {
    const cb = vi.fn()
    const off = onUiKeys(cb)
    setUiKeys('t1', 'dialog')
    setUiKeys('t1', 'no_composer')
    setUiKeys('t1', 'prompt')
    off()
    expect(cb.mock.calls).toEqual([
      ['t1', 'tui'],
      ['t1', 'prompt']
    ])
    expect(uiKeysOwner('t1')).toBe('prompt')
    expect(uiKeysOwner('unknown')).toBe(null)
  })
})
