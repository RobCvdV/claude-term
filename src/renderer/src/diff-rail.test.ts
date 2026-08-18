import { describe, expect, it } from 'vitest'
import type { ChangedFile, ProjectChanges, RevertResult, TurnStep } from '../../shared/types'
import {
  changeBadge,
  emptyReason,
  initialScope,
  inTurn,
  reselectChange,
  revertConfirmText,
  revertSummary,
  scopedFiles,
  totals,
  turnDepths,
  turnLabel,
  turnStep
} from './diff-rail'

const file = (rel: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path: `/p/${rel}`,
  rel,
  kind: 'modified',
  added: 1,
  removed: 1,
  ...over
})

const turn = (depth: number, files: string[], revertable = true): TurnStep => ({
  depth,
  startedAt: '2026-08-17T10:00:00Z',
  files,
  revertable
})

const changes = (over: Partial<ProjectChanges> = {}): ProjectChanges => ({
  files: [file('a.ts'), file('b.ts'), file('c.ts', { kind: 'untracked', added: 0, removed: 0 })],
  turns: [turn(1, ['/p/a.ts', '/p/c.ts'])],
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
    expect(initialScope(changes({ turns: [turn(1, [])] }))).toBe('all')
    // a turn that wrote a file which has since been committed
    expect(initialScope(changes({ turns: [turn(1, ['/p/committed.ts'])] }))).toBe('all')
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
    expect(emptyReason(changes({ turns: [turn(1, [])] }), 'turn')).toMatch(/turn did not change/)
  })

  it('is null when there is something to show', () => {
    expect(emptyReason(changes(), 'turn')).toBeNull()
  })
})

describe('revertConfirmText', () => {
  it('names every file and says what cannot be undone', () => {
    const text = revertConfirmText([file('a.ts'), file('new.ts', { kind: 'untracked' })])
    expect(text).toContain('2 files')
    expect(text).toContain('M  a.ts')
    expect(text).toContain('U  new.ts')
    expect(text).toContain('cannot be undone')
  })

  it('counts one file in the singular', () => {
    expect(revertConfirmText([file('a.ts')])).toContain('1 file?')
  })
})

describe('revertSummary', () => {
  const result = (actions: string[]): RevertResult => ({
    at: 0,
    steps: actions.map((action, i) => ({ rel: `f${i}.ts`, action: action as never }))
  })

  it('reports each outcome that happened', () => {
    expect(revertSummary(result(['restore', 'restore', 'remove', 'keep']))).toBe(
      'Reverted: 2 restored, 1 deleted, 1 left alone'
    )
  })

  it('calls out failures', () => {
    expect(revertSummary(result(['failed']))).toBe('Reverted: 1 failed')
  })

  it('says so when there was nothing to do', () => {
    expect(revertSummary(result([]))).toBe('Nothing to revert')
  })
})

describe('going further back than one turn', () => {
  const deep = changes({
    turns: [
      turn(1, ['/p/a.ts']),
      turn(2, ['/p/a.ts', '/p/b.ts']),
      turn(3, ['/p/a.ts', '/p/b.ts', '/p/c.ts'], false)
    ]
  })

  it('scopes to the cumulative file set of the chosen depth', () => {
    expect(scopedFiles(deep, 'turn', 1).map((f) => f.rel)).toEqual(['a.ts'])
    expect(scopedFiles(deep, 'turn', 2).map((f) => f.rel)).toEqual(['a.ts', 'b.ts'])
    expect(scopedFiles(deep, 'turn', 3).map((f) => f.rel)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('offers one depth per turn on record, and keeps their undo state', () => {
    expect(turnDepths(deep)).toEqual([1, 2, 3])
    expect(turnStep(deep, 2)?.revertable).toBe(true)
    expect(turnStep(deep, 3)?.revertable).toBe(false)
    expect(turnStep(deep, 4)).toBeNull()
  })

  it('names the depth the way the buttons read', () => {
    expect(turnLabel(1)).toBe('This turn')
    expect(turnLabel(3)).toBe('Last 3 turns')
  })

  it('marks a file as the turn’s own only within the chosen depth', () => {
    expect(inTurn(deep, file('b.ts'), 1)).toBe(false)
    expect(inTurn(deep, file('b.ts'), 2)).toBe(true)
  })

  it('confirms in the plural, and says which turn the files go back to', () => {
    const text = revertConfirmText([file('a.ts'), file('b.ts')], 2)
    expect(text).toMatch(/Undo the last 2 turns' changes to 2 files\?/)
    expect(text).toMatch(/when turn 2 started/)
    expect(revertConfirmText([file('a.ts')], 1)).toMatch(/Undo this turn's changes to 1 file\?/)
  })

  it('explains an empty deep scope in the plural', () => {
    const none = changes({ turns: [turn(1, []), turn(2, [])] })
    expect(emptyReason(none, 'turn', 2)).toMatch(/The last 2 turns did not change any files/)
  })
})
