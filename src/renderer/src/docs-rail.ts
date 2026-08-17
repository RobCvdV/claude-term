/** What the file window lists, and which file it lands on. Pure — the view
 *  renders these; keeping the choice here is what makes it testable. */

import type { DocEntry, DocGroup, DocTarget, ProjectDocs } from '../../shared/types'
import { languageForFile, MARKDOWN_LANG } from './config-lang'

/** One selectable file in the rail, whatever listing it came from: a plan, a
 *  doc, a configuration file, or a file picked out of the tree. */
export interface FileItem {
  path: string
  /** what the rail shows — a doc's title, a config file's relative path */
  label: string
  size: number
}

/** A labelled run of files in the rail. */
export interface RailGroup {
  name: string
  /** shown under the heading when a group's root isn't the tab's own cwd */
  subtitle?: string
  items: FileItem[]
}

const docItems = (entries: DocEntry[]): FileItem[] =>
  entries.map((e) => ({ path: e.path, label: e.title, size: e.size }))

/** The rail's groups, in order: the curated markdown first, then the project's
 *  configuration files. The tree below them reaches everything else. */
export function railGroups(d: ProjectDocs): RailGroup[] {
  const groups: RailGroup[] = [
    { name: 'Plan', items: docItems(d.plans) },
    { name: 'Roadmap', items: docItems(d.roadmap ? [d.roadmap] : []) },
    ...d.sections.map((s) => ({ name: s.name, items: docItems(s.entries) })),
    // the first config section is the tab's own root; later ones are added
    // directories (and the app's own pattern list), so they name themselves
    ...d.config.map((s, i) => ({
      name: i === 0 ? 'Settings' : `Settings · ${s.name}`,
      subtitle: s.subtitle,
      items: s.entries.map((e) => ({ path: e.path, label: e.rel, size: e.size }))
    }))
  ]
  return groups.filter((g) => g.items.length)
}

/** Where a landing group starts, falling back through the others so a window
 *  opened on an empty group still shows something. */
export function pickInitial(d: ProjectDocs, group: DocGroup): FileItem | null {
  const first = (name: DocGroup): FileItem | null => {
    if (name === 'plan') return docItems(d.plans)[0] ?? null
    if (name === 'roadmap') return docItems(d.roadmap ? [d.roadmap] : [])[0] ?? null
    if (name === 'docs') return docItems(d.sections[0]?.entries ?? [])[0] ?? null
    const e = d.config[0]?.entries[0]
    return e ? { path: e.path, label: e.rel, size: e.size } : null
  }
  for (const name of [group, 'plan', 'roadmap', 'docs', 'settings'] as DocGroup[]) {
    const hit = first(name)
    if (hit) return hit
  }
  return null
}

/** The file a target points at: its listed entry, else a stand-in built from the
 *  file name — a file deeper than the listings reach is opened all the same. */
export function targetEntry(d: ProjectDocs, target?: DocTarget | null): FileItem | null {
  if (!target) return null
  const hit = railGroups(d)
    .flatMap((g) => g.items)
    .find((e) => e.path === target.path)
  if (hit) return hit
  const name = target.path.split('/').pop() ?? target.path
  // size 0: a target is a file the app just created, never something to gate
  return { path: target.path, label: name.replace(/\.md$/i, ''), size: 0 }
}

/** Markdown opens in its rendered preview; anything else has nothing to render,
 *  so it opens in the editor — which is what the settings window always did. */
export function modeFor(path: string): 'view' | 'edit' {
  return languageForFile(path) === MARKDOWN_LANG ? 'view' : 'edit'
}

/** What the window shows after (re-)listing a project. */
export interface Landing {
  item: FileItem | null
  mode: 'view' | 'edit'
  /** put the cursor at the end of the file — a new file is written into, and a
   *  seeded `# Heading` is something to type under, not over */
  atEnd: boolean
  /** 1-based line to put the cursor on, from a `path:line` terminal link */
  line?: number
  column?: number
}

/**
 * Which file the window lands on once a listing arrives. A file this window
 * just created wins: it is why the list was re-read, and it opens ready to type
 * in. Otherwise the owner tab's target wins, and failing that the group's own
 * first entry.
 */
export function landingFor(
  d: ProjectDocs,
  {
    created,
    target,
    group
  }: { created?: string | null; target?: DocTarget | null; group: DocGroup }
): Landing {
  if (created) {
    return { item: targetEntry(d, { path: created, edit: true }), mode: 'edit', atEnd: true }
  }
  if (target) {
    return {
      item: targetEntry(d, target),
      // a line to land on means the editor, whatever the file renders as
      mode: target.edit || target.line ? 'edit' : 'view',
      atEnd: !!target.edit && !target.line,
      line: target.line,
      column: target.column
    }
  }
  const item = pickInitial(d, group)
  return { item, mode: item ? modeFor(item.path) : 'view', atEnd: false }
}
