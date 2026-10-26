/** The file rail as a flat list of rows, and what the keys do to it. Pure — the
 *  component renders and dispatches; keeping the choices here makes them testable. */

import type { TreeNode, TreeRoot } from '../../shared/types'
import type { FileItem, RailGroup } from './docs-rail'

export const QUICK = 'quick'
export const groupId = (name: string): string => `group:${name}`
/** A Quick Access entry: the same file can also be a row of a project tree. */
export const quickId = (path: string): string => `q:${path}`

export type RailRow =
  /** Quick Access, or a project folder (`dir` set: it is the folder itself) */
  | {
      kind: 'header'
      id: string
      label: string
      title?: string
      depth: 0
      open: boolean
      dir?: string
    }
  | { kind: 'group'; id: string; label: string; subtitle?: string; depth: 1; open: boolean }
  /** a group's title while filtering: always open, not a stop for the keys */
  | { kind: 'label'; id: string; label: string; depth: 0 }
  | { kind: 'item'; id: string; item: FileItem; depth: number }
  | { kind: 'dir'; id: string; node: TreeNode; depth: number; open: boolean; excluded: boolean }
  | { kind: 'file'; id: string; node: TreeNode; depth: number; excluded: boolean }
  | { kind: 'note'; id: string; text: string; depth: number }

export type OpenableRow = Extract<RailRow, { open: boolean }>

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/** Quick Access groups and their entries, A–Z ignoring case. */
export function sortGroups(groups: RailGroup[]): RailGroup[] {
  return [...groups]
    .sort((a, b) => byName(a.name, b.name))
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => byName(a.label, b.label)) }))
}

/** Every visible row of the rail with nothing typed in the filter box. */
export function buildRows(opts: {
  groups: RailGroup[]
  roots: TreeRoot[]
  entries: ReadonlyMap<string, TreeNode[]>
  open: ReadonlySet<string>
}): RailRow[] {
  const { groups, roots, entries, open } = opts
  const rows: RailRow[] = []
  if (groups.length) {
    const quickOpen = open.has(QUICK)
    rows.push({ kind: 'header', id: QUICK, label: 'Quick Access', depth: 0, open: quickOpen })
    if (quickOpen) {
      for (const g of sortGroups(groups)) {
        const id = groupId(g.name)
        const gOpen = open.has(id)
        rows.push({ kind: 'group', id, label: g.name, subtitle: g.subtitle, depth: 1, open: gOpen })
        if (!gOpen) continue
        for (const item of g.items)
          rows.push({ kind: 'item', id: quickId(item.path), item, depth: 2 })
      }
    }
  }
  const children = (dir: string, depth: number, excluded: boolean): void => {
    const kids = entries.get(dir)
    if (!kids || !kids.length) {
      const text = kids ? 'empty' : '…'
      rows.push({ kind: 'note', id: `${dir}:note`, text, depth })
      return
    }
    for (const node of kids) {
      const ex = excluded || !!node.excluded
      if (!node.isDir) {
        rows.push({ kind: 'file', id: node.path, node, depth, excluded: ex })
        continue
      }
      const isOpen = open.has(node.path)
      rows.push({ kind: 'dir', id: node.path, node, depth, open: isOpen, excluded: ex })
      if (isOpen) children(node.path, depth + 1, ex)
    }
  }
  for (const root of roots) {
    const isOpen = open.has(root.path)
    rows.push({
      kind: 'header',
      id: root.path,
      label: root.name,
      title: root.path,
      depth: 0,
      open: isOpen,
      dir: root.path
    })
    if (isOpen) children(root.path, 1, false)
  }
  return rows
}

/** The rows while filtering: the matching Quick Access entries and project
 *  files, under their group titles. */
export function filterRows(groups: RailGroup[], elsewhere: FileItem[]): RailRow[] {
  const rows: RailRow[] = []
  const all = [...sortGroups(groups)]
  if (elsewhere.length) all.push({ name: 'Elsewhere in the project', items: elsewhere })
  for (const g of all) {
    rows.push({ kind: 'label', id: `label:${g.name}`, label: g.name, depth: 0 })
    for (const item of g.items) {
      rows.push({ kind: 'item', id: `${g.name}:${item.path}`, item, depth: 1 })
    }
  }
  return rows
}

export const focusable = (row: RailRow): boolean => row.kind !== 'note' && row.kind !== 'label'

export const isOpenable = (row: RailRow): row is OpenableRow => 'open' in row

/** What type-to-jump matches a row by. */
export function rowName(row: RailRow): string {
  switch (row.kind) {
    case 'item':
      return row.item.label
    case 'dir':
    case 'file':
      return row.node.name
    case 'note':
      return ''
    default:
      return row.label
  }
}

/** The file or folder a row stands for, if any. */
export function rowPath(row: RailRow): string | undefined {
  if (row.kind === 'item') return row.item.path
  if (row.kind === 'dir' || row.kind === 'file') return row.node.path
  if (row.kind === 'header') return row.dir
  return undefined
}

/** Where a paste on this row lands: the folder itself, or a file's folder.
 *  Quick Access rows have none — they are a listing, not a place. */
export function pasteDir(row: RailRow): string | undefined {
  if (row.kind === 'header') return row.dir
  if (row.kind === 'dir') return row.node.path
  if (row.kind === 'file') return row.node.path.slice(0, row.node.path.lastIndexOf('/'))
  return undefined
}

const indexOf = (rows: RailRow[], id: string | null): number =>
  id === null ? -1 : rows.findIndex((r) => r.id === id)

/** The first row the keys can stop on. */
export function firstStop(rows: RailRow[]): string | null {
  return rows.find(focusable)?.id ?? null
}

/** ↑ / ↓ (and Home / End as ±Infinity): the next stop that way, staying put at
 *  either end. A cursor that is no longer visible starts from the top. */
export function step(rows: RailRow[], id: string | null, delta: number): string | null {
  const at = indexOf(rows, id)
  if (at < 0) return firstStop(rows)
  const dir = delta > 0 ? 1 : -1
  let found = at
  let left = Math.abs(delta)
  for (let i = at + dir; i >= 0 && i < rows.length && left > 0; i += dir) {
    if (!focusable(rows[i])) continue
    found = i
    left--
  }
  return rows[found].id
}

/** The row a nested one sits under. */
export function parentOf(rows: RailRow[], id: string): string | null {
  const at = indexOf(rows, id)
  if (at < 0) return null
  const depth = rows[at].depth
  for (let i = at - 1; i >= 0; i--) {
    if (rows[i].depth < depth && isOpenable(rows[i])) return rows[i].id
  }
  return null
}

/** → : open a closed folder or group; on an open one, step to its first child. */
export function right(rows: RailRow[], id: string): { open?: string; cursor?: string } {
  const at = indexOf(rows, id)
  const row = rows[at]
  if (!row || !isOpenable(row)) return {}
  if (!row.open) return { open: row.id }
  const next = rows[at + 1]
  return next && next.depth > row.depth && focusable(next) ? { cursor: next.id } : {}
}

/** ← : close an open folder or group; anywhere else, go to its parent. */
export function left(rows: RailRow[], id: string): { close?: string; cursor?: string } {
  const row = rows[indexOf(rows, id)]
  if (!row) return {}
  if (isOpenable(row) && row.open) return { close: row.id }
  const parent = parentOf(rows, id)
  return parent ? { cursor: parent } : {}
}

/** Type-to-jump: the next row whose name starts with `prefix`, wrapping. A
 *  longer prefix may stay on the current row; a fresh one moves past it. */
export function jump(
  rows: RailRow[],
  id: string | null,
  prefix: string,
  stayIfMatches: boolean
): string | null {
  const want = prefix.toLowerCase()
  const n = rows.length
  const at = indexOf(rows, id)
  for (let k = stayIfMatches ? 0 : 1; k <= n; k++) {
    const row = rows[(((at + k) % n) + n) % n]
    if (focusable(row) && rowName(row).toLowerCase().startsWith(want)) return row.id
  }
  return null
}

/** The folders to open, root first, for `path` to show in its tree. */
export function ancestorsIn(root: string, path: string): string[] {
  if (!path.startsWith(root + '/')) return []
  const dirs = [root]
  for (let i = path.indexOf('/', root.length + 1); i > 0; i = path.indexOf('/', i + 1)) {
    dirs.push(path.slice(0, i))
  }
  return dirs
}
