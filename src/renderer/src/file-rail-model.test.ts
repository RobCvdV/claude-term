import { describe, expect, it } from 'vitest'
import type { LineHit, TreeNode } from '../../shared/types'
import type { RailGroup } from './docs-rail'
import {
  ancestorsIn,
  buildRows,
  contentRows,
  filterRows,
  groupId,
  jump,
  left,
  pasteDir,
  QUICK,
  rowName,
  rowPath,
  quickId,
  right,
  step,
  type RailRow
} from './file-rail-model'

const file = (path: string, excluded?: boolean): TreeNode => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  isDir: false,
  size: 1,
  ...(excluded ? { excluded } : {})
})
const dir = (path: string, excluded?: boolean): TreeNode => ({
  ...file(path, excluded),
  isDir: true,
  size: 0
})

const groups: RailGroup[] = [
  { name: 'settings', items: [{ path: '/r/b.json', label: 'b.json', size: 1 }] },
  {
    name: 'Plan',
    items: [
      { path: '/p/z.md', label: 'zeta', size: 1 },
      { path: '/p/a.md', label: 'Alpha', size: 1 }
    ]
  }
]
const roots = [{ path: '/r', name: 'r' }]
const entries = new Map<string, TreeNode[]>([
  ['/r', [dir('/r/node_modules', true), dir('/r/src'), file('/r/README.md')]],
  ['/r/src', [file('/r/src/a.ts'), file('/r/src/B.ts')]],
  ['/r/node_modules', [dir('/r/node_modules/pkg')]]
])

const ids = (rows: RailRow[]): string[] => rows.map((r) => r.id)
const rowsWith = (...open: string[]): RailRow[] =>
  buildRows({ groups, roots, entries, open: new Set(open) })

describe('buildRows', () => {
  it('shows Quick Access groups A–Z, collapsed, above each project folder', () => {
    expect(ids(rowsWith(QUICK, '/r'))).toEqual([
      QUICK,
      groupId('Plan'),
      groupId('settings'),
      '/r',
      '/r/node_modules',
      '/r/src',
      '/r/README.md'
    ])
  })

  it('lists an open group’s entries A–Z and an open folder’s children', () => {
    expect(ids(rowsWith(QUICK, groupId('Plan'), '/r', '/r/src'))).toEqual([
      QUICK,
      groupId('Plan'),
      quickId('/p/a.md'),
      quickId('/p/z.md'),
      groupId('settings'),
      '/r',
      '/r/node_modules',
      '/r/src',
      '/r/src/a.ts',
      '/r/src/B.ts',
      '/r/README.md'
    ])
  })

  it('carries exclusion down into an excluded folder', () => {
    const rows = rowsWith('/r', '/r/node_modules')
    const pkg = rows.find((r) => r.id === '/r/node_modules/pkg')
    expect(pkg).toMatchObject({ kind: 'dir', excluded: true })
  })

  it('notes a folder still loading', () => {
    const rows = rowsWith('/r', '/r/node_modules', '/r/node_modules/pkg')
    expect(rows.find((r) => r.id === '/r/node_modules/pkg:note')).toMatchObject({ text: '…' })
  })
})

describe('keys', () => {
  const rows = rowsWith(QUICK, '/r', '/r/src')

  it('↑ ↓ step between rows and stop at the ends', () => {
    expect(step(rows, QUICK, 1)).toBe(groupId('Plan'))
    expect(step(rows, QUICK, -1)).toBe(QUICK)
    expect(step(rows, '/r/src/B.ts', 1)).toBe('/r/README.md')
    expect(step(rows, '/r/README.md', 1)).toBe('/r/README.md')
    expect(step(rows, QUICK, Infinity)).toBe('/r/README.md')
    expect(step(rows, 'gone', 1)).toBe(QUICK)
  })

  it('↑ ↓ skip notes and filter labels', () => {
    const filtered = filterRows(groups, [])
    expect(step(filtered, null, 1)).toBe('Plan:/p/a.md')
    expect(step(filtered, 'Plan:/p/z.md', 1)).toBe('settings:/r/b.json')
  })

  it('→ opens, then steps into; ← closes, then steps out', () => {
    expect(right(rows, groupId('Plan'))).toEqual({ open: groupId('Plan') })
    expect(right(rows, '/r/src')).toEqual({ cursor: '/r/src/a.ts' })
    expect(right(rows, '/r/src/a.ts')).toEqual({})
    expect(left(rows, '/r/src')).toEqual({ close: '/r/src' })
    expect(left(rows, '/r/src/a.ts')).toEqual({ cursor: '/r/src' })
    expect(left(rows, '/r/README.md')).toEqual({ cursor: '/r' })
    expect(left(rows, groupId('Plan'))).toEqual({ cursor: QUICK })
  })

  it('type-to-jump finds the next match, ignoring case, and wraps', () => {
    expect(jump(rows, QUICK, 's', false)).toBe(groupId('settings'))
    expect(jump(rows, groupId('settings'), 's', false)).toBe('/r/src')
    expect(jump(rows, '/r/src', 'b', false)).toBe('/r/src/B.ts')
    expect(jump(rows, '/r/README.md', 'q', false)).toBe(QUICK)
    expect(jump(rows, '/r/src', 'sr', true)).toBe('/r/src')
    expect(jump(rows, QUICK, 'xyz', false)).toBeNull()
  })
})

describe('paste and reveal', () => {
  it('pastes into a folder, a file’s folder, never Quick Access', () => {
    const rows = rowsWith(QUICK, groupId('Plan'), '/r', '/r/src')
    const at = (id: string): string | undefined => pasteDir(rows.find((r) => r.id === id)!)
    expect(at('/r')).toBe('/r')
    expect(at('/r/src')).toBe('/r/src')
    expect(at('/r/src/a.ts')).toBe('/r/src')
    expect(at(quickId('/p/a.md'))).toBeUndefined()
  })

  it('opens every folder above a file, root first', () => {
    expect(ancestorsIn('/r', '/r/src/main/x.ts')).toEqual(['/r', '/r/src', '/r/src/main'])
    expect(ancestorsIn('/r', '/r/x.ts')).toEqual(['/r'])
    expect(ancestorsIn('/r', '/other/x.ts')).toEqual([])
  })
})

describe('contentRows', () => {
  const hit = (line: number): LineHit => ({
    line,
    column: 1,
    length: 3,
    preview: 'foo',
    previewAt: 0
  })
  const found = {
    matches: [{ path: '/r/a.ts', name: 'a.ts', size: 9, hits: [hit(2), hit(7)] }],
    truncated: false,
    skippedLarge: 0
  }

  it('lists each file, landing on its first hit, then its lines', () => {
    const rows = contentRows(found)
    expect(rows.map((r) => [r.kind, r.depth])).toEqual([
      ['item', 0],
      ['hit', 1],
      ['hit', 1]
    ])
    expect(rows[0]).toMatchObject({ at: { line: 2 } })
    expect(rows.slice(1).map(rowPath)).toEqual(['/r/a.ts', '/r/a.ts'])
    // type-to-jump goes by file names, not by line text
    expect(rowName(rows[1])).toBe('')
    expect(step(rows, rows[0].id, 2)).toBe(rows[2].id)
  })

  it('says when it stopped short or left files out', () => {
    const rows = contentRows({ ...found, truncated: true, skippedLarge: 2 })
    expect(rows.filter((r) => r.kind === 'note').map((r) => r.kind === 'note' && r.text)).toEqual([
      'More matches not shown — narrow the search',
      '2 files are too large to search'
    ])
  })
})
