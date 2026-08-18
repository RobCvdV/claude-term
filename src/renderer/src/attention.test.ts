import { describe, expect, it } from 'vitest'
import { needsInput, nextAttentionTab } from './attention'
import type { TabStatus } from '../../shared/types'

const status = (overrides: Partial<TabStatus>): TabStatus => ({
  tabId: 't1',
  claudeActive: true,
  activity: 'idle',
  busySince: null,
  sessionId: 'sess-1',
  exitCode: null,
  cwd: '/dev/repo',
  addedDirs: [],
  removedDirs: [],
  payload: null,
  git: null,
  ci: null,
  extraRepos: [],
  ...overrides
})

const tabs = (...ids: string[]): { tabId: string }[] => ids.map((tabId) => ({ tabId }))
const attention = status({ activity: 'needs-attention' })
const idle = status({})

describe('needsInput', () => {
  it('only a claude tab blocked on a dialog qualifies', () => {
    expect(needsInput(attention)).toBe(true)
    expect(needsInput(idle)).toBe(false)
    expect(needsInput(status({ activity: 'needs-attention', claudeActive: false }))).toBe(false)
    expect(needsInput(null)).toBe(false)
  })
})

describe('nextAttentionTab', () => {
  it('finds the next waiting tab after the active one', () => {
    expect(nextAttentionTab(tabs('a', 'b', 'c'), { a: idle, b: attention, c: idle }, 'a')).toBe('b')
  })

  it('wraps around the end of the tab strip', () => {
    expect(nextAttentionTab(tabs('a', 'b', 'c'), { a: attention, b: idle, c: idle }, 'b')).toBe('a')
  })

  it('skips nearer tabs that are not waiting', () => {
    expect(
      nextAttentionTab(tabs('a', 'b', 'c', 'd'), { b: idle, c: idle, d: attention }, 'a')
    ).toBe('d')
  })

  it('never returns the active tab, even when it is waiting', () => {
    expect(nextAttentionTab(tabs('a', 'b'), { a: attention, b: idle }, 'a')).toBe(null)
  })

  it('prefers another waiting tab over staying on the active one', () => {
    expect(nextAttentionTab(tabs('a', 'b', 'c'), { a: attention, c: attention }, 'a')).toBe('c')
  })

  it('returns null when nothing waits or there are no tabs', () => {
    expect(nextAttentionTab(tabs('a', 'b'), { a: idle, b: idle }, 'a')).toBe(null)
    expect(nextAttentionTab([], {}, null)).toBe(null)
  })

  it('scans all tabs when no tab is active', () => {
    expect(nextAttentionTab(tabs('a', 'b'), { b: attention }, null)).toBe('b')
  })
})
