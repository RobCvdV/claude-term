import { describe, expect, it } from 'vitest'
import type { ChangedFile, ProjectChanges } from '../../shared/types'
import {
  changeBadge,
  emptyReason,
  initialScope,
  inTurn,
  reselectChange,
  scopedFiles,
  totals
} from './diff-rail'

const file = (rel: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path: `/p/${rel}`,
  rel,
  kind: 'modified',
  added: 1,
  removed: 1,
  ...over
})

const changes = (over: Partial<ProjectChanges> = {}): ProjectChanges => ({
  files: [file('a.ts'), file('b.ts'), file('c.ts', { kind: 'untracked', added: 0, removed: 0 })],
  turnFiles: ['/p/a.ts', '/p/c.ts'],
  turnStartedAt: '2026-08-17T10:00:00Z',
  inRepo: true,
  ...over
})

describe('changeBadge', () => {
  it('reads like git status --short', () => {
    expect(
      (['modified', 'added', 'deleted', 'renamed', 'untracked'] as const).map(changeBadge)
    ).toEqual(['M', 'A', 'D', 'R', 'U'])
  })
})

describe('scope', () => {
  it('the turn scope keeps only what the turn wrote', () => {
    expect(scopedFiles(changes(), 'turn').map((f) => f.rel)).toEqual(['a.ts', 'c.ts'])
  })

  it('the all scope keeps the whole working tree', () => {
    expect(scopedFiles(changes(), 'all')).toHaveLength(3)
  })

  it('opens on the turn when it changed something', () => {
    expect(initialScope(changes())).toBe('turn')
  })

  it('opens on everything when the turn changed nothing', () => {
    expect(initialScope(changes({ turnFiles: [] }))).toBe('all')
    // a turn that wrote a file which has since been committed
    expect(initialScope(changes({ turnFiles: ['/p/committed.ts'] }))).toBe('all')
  })

  it('marks the turn’s own files', () => {
    const c = changes()
    expect(inTurn(c, file('a.ts'))).toBe(true)
    expect(inTurn(c, file('b.ts'))).toBe(false)
  })
})

describe('reselectChange', () => {
  it('keeps the open file when it is still changed', () => {
    expect(reselectChange(changes().files, '/p/b.ts')?.rel).toBe('b.ts')
  })

  it('falls back to the first when it is not, and to nothing when there are none', () => {
    expect(reselectChange(changes().files, '/p/gone.ts')?.rel).toBe('a.ts')
    expect(reselectChange([], '/p/a.ts')).toBeNull()
  })
})

describe('totals', () => {
  it('adds up both columns', () => {
    expect(totals(changes().files)).toEqual({ added: 2, removed: 2 })
    expect(totals([])).toEqual({ added: 0, removed: 0 })
  })
})

describe('emptyReason', () => {
  it('says when the folder is not a repository', () => {
    expect(emptyReason(changes({ inRepo: false }), 'all')).toMatch(/not in a git repository/)
  })

  it('says when nothing changed at all', () => {
    expect(emptyReason(changes({ files: [] }), 'all')).toMatch(/Nothing has changed/)
  })

  it('says when only this turn is empty', () => {
    expect(emptyReason(changes({ turnFiles: [] }), 'turn')).toMatch(/turn did not change/)
  })

  it('is null when there is something to show', () => {
    expect(emptyReason(changes(), 'turn')).toBeNull()
  })
})
