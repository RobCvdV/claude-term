import { describe, expect, it } from 'vitest'
import { currentModelAlias } from './model-choices'

describe('currentModelAlias', () => {
  it('finds the family in a full model id', () => {
    expect(currentModelAlias('claude-opus-5-5')).toBe('opus')
    expect(currentModelAlias('claude-sonnet-5-5[1m]')).toBe('sonnet')
    expect(currentModelAlias('Claude-Fable-5-2')).toBe('fable')
  })

  it('returns null for unknown or missing ids', () => {
    expect(currentModelAlias('deepseek-chat')).toBe(null)
    expect(currentModelAlias(undefined)).toBe(null)
  })
})
