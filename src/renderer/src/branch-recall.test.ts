import { describe, expect, it } from 'vitest'
import { agoLabel, branchKey, rankBranches } from './branch-recall'
import type { BranchHistoryEntry } from '../../shared/types'

const T0 = 1_700_000_000_000

function entry(branch: string, root = '/dev/repo', lastUsed = T0): BranchHistoryEntry {
  return { root, branch, lastUsed }
}

describe('rankBranches', () => {
  it('shows only the freshest few when there is no query', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`feature/b${i}`, '/dev/repo', T0 - i * 1000)
    )
    const out = rankBranches('', entries, new Set())
    expect(out).toHaveLength(5)
    expect(out[0].branch).toBe('feature/b0')
  })

  it('finds a branch by its ticket number', () => {
    const entries = [entry('feature/other'), entry('bugfix/MTX-10302-fix-login')]
    const out = rankBranches('mtx-10302', entries, new Set())
    expect(out.map((e) => e.branch)).toEqual(['bugfix/MTX-10302-fix-login'])
  })

  it('matches on the repo folder name too', () => {
    const entries = [
      entry('feature/x', '/dev/mendrix-mobile-next'),
      entry('feature/x', '/dev/qedit')
    ]
    const out = rankBranches('qedit', entries, new Set())
    expect(out).toEqual([entries[1]])
  })

  it('breaks score ties by recency', () => {
    const entries = [
      entry('feature/MTX-1-aaa', '/dev/repo', T0 - 5000),
      entry('feature/MTX-2-aaa', '/dev/repo', T0)
    ]
    const out = rankBranches('aaa', entries, new Set())
    expect(out[0].branch).toBe('feature/MTX-2-aaa')
  })

  it('hides branches that an open tab is currently on', () => {
    const entries = [entry('feature/x'), entry('feature/y')]
    const out = rankBranches('', entries, new Set([branchKey('/dev/repo', 'feature/x')]))
    expect(out.map((e) => e.branch)).toEqual(['feature/y'])
  })
})

describe('agoLabel', () => {
  it('formats each magnitude', () => {
    expect(agoLabel(T0 - 30_000, T0)).toBe('just now')
    expect(agoLabel(T0 - 5 * 60_000, T0)).toBe('5m ago')
    expect(agoLabel(T0 - 3 * 3_600_000, T0)).toBe('3h ago')
    expect(agoLabel(T0 - 2 * 86_400_000, T0)).toBe('2d ago')
    expect(agoLabel(T0 - 21 * 86_400_000, T0)).toBe('3w ago')
  })
})
