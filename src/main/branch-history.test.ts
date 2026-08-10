import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BranchHistory } from './branch-history'

let file: string
let store: BranchHistory

const T0 = 1_700_000_000_000

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'claude-term-branches-')), 'branch-history.json')
  store = new BranchHistory(() => file)
})

describe('record / recent', () => {
  it('remembers branches most-recent first', () => {
    store.record('/repo/a', 'bugfix/MTX-10001-fix-thing', T0)
    store.record('/repo/b', 'feature/MTX-10002-add-thing', T0 + 1000)
    expect(store.recent().map((e) => e.branch)).toEqual([
      'feature/MTX-10002-add-thing',
      'bugfix/MTX-10001-fix-thing'
    ])
  })

  it('bumps recency of a re-seen branch instead of duplicating it', () => {
    store.record('/repo/a', 'feature/x', T0)
    store.record('/repo/a', 'feature/y', T0 + 1000)
    store.record('/repo/a', 'feature/x', T0 + 120_000)
    const all = store.recent()
    expect(all).toHaveLength(2)
    expect(all[0].branch).toBe('feature/x')
    expect(all[0].lastUsed).toBe(T0 + 120_000)
  })

  it('keeps the same branch name in different repos as separate entries', () => {
    store.record('/repo/a', 'feature/x', T0)
    store.record('/repo/b', 'feature/x', T0 + 1000)
    expect(store.recent()).toHaveLength(2)
  })

  it('throttles recency bumps within the min gap (no rewrite per git poll)', () => {
    store.record('/repo/a', 'feature/x', T0)
    store.record('/repo/a', 'feature/x', T0 + 10_000)
    expect(store.recent()[0].lastUsed).toBe(T0)
  })

  it('skips long-lived branches and detached HEAD', () => {
    for (const b of ['main', 'master', 'develop', 'HEAD']) store.record('/repo/a', b, T0)
    expect(store.recent()).toEqual([])
  })

  it('caps the store at 200 entries, dropping the oldest', () => {
    for (let i = 0; i < 210; i++) store.record('/repo/a', `feature/b${i}`, T0 + i * 1000)
    const all = store.recent(1000)
    expect(all).toHaveLength(200)
    expect(all[0].branch).toBe('feature/b209')
    expect(all[199].branch).toBe('feature/b10')
  })
})

describe('persistence', () => {
  it('round-trips through the file', () => {
    store.record('/repo/a', 'feature/x', T0)
    const reloaded = new BranchHistory(() => file)
    expect(reloaded.recent()).toEqual([{ root: '/repo/a', branch: 'feature/x', lastUsed: T0 }])
  })

  it('survives a corrupt or missing file', () => {
    expect(store.recent()).toEqual([])
    writeFileSync(file, 'not json')
    expect(new BranchHistory(() => file).recent()).toEqual([])
    writeFileSync(file, JSON.stringify([{ bad: true }, { root: '/r', branch: 'b', lastUsed: T0 }]))
    expect(new BranchHistory(() => file).recent()).toEqual([
      { root: '/r', branch: 'b', lastUsed: T0 }
    ])
  })

  it('writes valid JSON to disk', () => {
    store.record('/repo/a', 'feature/x', T0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1)
  })
})
