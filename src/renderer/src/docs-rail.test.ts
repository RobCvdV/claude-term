import { describe, expect, it } from 'vitest'
import type { ProjectDocs } from '../../shared/types'
import { landingFor, modeFor, pickInitial, railGroups, targetEntry } from './docs-rail'

const doc = (
  path: string,
  title = path
): { path: string; title: string; mtime: number; size: number } => ({
  path,
  title,
  mtime: 0,
  size: 10
})

const docs = (over: Partial<ProjectDocs> = {}): ProjectDocs => ({
  plans: [doc('/p/.claude/plans/plan.md', 'The plan')],
  roadmap: doc('/p/ROADMAP.md', 'Roadmap'),
  sections: [{ name: 'docs', entries: [doc('/p/docs/guide.md', 'Guide')] }],
  roots: [{ path: '/p', name: 'p' }],
  config: [
    {
      name: 'p',
      root: '/p',
      subtitle: undefined,
      entries: [
        { path: '/p/.claude/settings.json', rel: '.claude/settings.json', size: 20, mtime: 0 }
      ]
    }
  ],
  patternsFile: '/u/config-file-patterns.json',
  ...over
})

describe('railGroups', () => {
  it('lists the curated markdown first, then the settings', () => {
    expect(railGroups(docs()).map((g) => g.name)).toEqual(['Plan', 'Roadmap', 'docs', 'Settings'])
  })

  it('drops groups with nothing in them', () => {
    const thin = docs({ plans: [], roadmap: null })
    expect(railGroups(thin).map((g) => g.name)).toEqual(['docs', 'Settings'])
  })

  it('names later config sections after their own root', () => {
    const two = docs({
      config: [
        {
          name: 'p',
          root: '/p',
          entries: [{ path: '/p/a.json', rel: 'a.json', size: 1, mtime: 0 }]
        },
        {
          name: 'lib',
          root: '/lib',
          subtitle: '/lib',
          entries: [{ path: '/lib/b.json', rel: 'b.json', size: 1, mtime: 0 }]
        }
      ]
    })
    expect(railGroups(two).map((g) => g.name)).toContain('Settings · lib')
  })
})

describe('pickInitial', () => {
  it('lands on the group that was asked for', () => {
    expect(pickInitial(docs(), 'roadmap')?.path).toBe('/p/ROADMAP.md')
    expect(pickInitial(docs(), 'settings')?.path).toBe('/p/.claude/settings.json')
  })

  it('falls through to another group rather than showing nothing', () => {
    const noPlans = docs({ plans: [], roadmap: null, sections: [] })
    expect(pickInitial(noPlans, 'plan')?.path).toBe('/p/.claude/settings.json')
  })

  it('has nothing to land on in an empty project', () => {
    expect(
      pickInitial(docs({ plans: [], roadmap: null, sections: [], config: [] }), 'plan')
    ).toBeNull()
  })
})

describe('targetEntry', () => {
  it('uses the listed entry when the target is one of them', () => {
    expect(targetEntry(docs(), { path: '/p/docs/guide.md' })).toEqual({
      path: '/p/docs/guide.md',
      label: 'Guide',
      size: 10
    })
  })

  it('stands in for a file no listing reaches (opened from the tree)', () => {
    expect(targetEntry(docs(), { path: '/p/src/deep/thing.ts' })).toEqual({
      path: '/p/src/deep/thing.ts',
      label: 'thing.ts',
      size: 0
    })
  })
})

describe('modeFor', () => {
  it('previews markdown and edits everything else', () => {
    expect(modeFor('/p/README.md')).toBe('view')
    expect(modeFor('/p/.gitignore')).toBe('edit')
    expect(modeFor('/p/notes')).toBe('edit')
  })
})

describe('landingFor', () => {
  it('opens a file this window just created, ready to type in', () => {
    const landing = landingFor(docs(), { created: '/p/docs/brand-new.md', group: 'settings' })
    expect(landing).toEqual({
      item: { path: '/p/docs/brand-new.md', label: 'brand-new', size: 0 },
      mode: 'edit',
      atEnd: true
    })
  })

  it('opens a new file in the editor even though markdown normally previews', () => {
    // an empty file has nothing to preview — the point of making it is to write
    expect(landingFor(docs(), { created: '/p/docs/guide.md', group: 'docs' }).mode).toBe('edit')
  })

  it('lets a just-created file win over the group and the target', () => {
    const landing = landingFor(docs(), {
      created: '/p/docs/brand-new.md',
      target: { path: '/p/ROADMAP.md' },
      group: 'roadmap'
    })
    expect(landing.item?.path).toBe('/p/docs/brand-new.md')
  })

  it('follows the owner tab’s target when nothing was created', () => {
    expect(landingFor(docs(), { target: { path: '/p/ROADMAP.md' }, group: 'plan' })).toEqual({
      item: { path: '/p/ROADMAP.md', label: 'Roadmap', size: 10 },
      mode: 'view',
      atEnd: false
    })
    expect(
      landingFor(docs(), { target: { path: '/p/ROADMAP.md', edit: true }, group: 'plan' })
    ).toMatchObject({ mode: 'edit', atEnd: true })
  })

  it('opens the editor at the line a terminal link carried', () => {
    const landing = landingFor(docs(), {
      target: { path: '/p/ROADMAP.md', line: 42, column: 7 },
      group: 'plan'
    })
    // markdown would normally open in its preview; a line means the editor
    expect(landing).toMatchObject({ mode: 'edit', line: 42, column: 7, atEnd: false })
  })

  it('opens a file no listing reaches, labelled by its name', () => {
    const landing = landingFor(docs(), {
      target: { path: '/p/src/main/ipc.ts', line: 403 },
      group: 'docs'
    })
    expect(landing.item).toEqual({ path: '/p/src/main/ipc.ts', label: 'ipc.ts', size: 0 })
    expect(landing.line).toBe(403)
  })

  it('otherwise lands on the group, in the mode that file deserves', () => {
    expect(landingFor(docs(), { group: 'roadmap' })).toEqual({
      item: { path: '/p/ROADMAP.md', label: 'Roadmap', size: 10 },
      mode: 'view',
      atEnd: false
    })
    expect(landingFor(docs(), { group: 'settings' })).toMatchObject({ mode: 'edit', atEnd: false })
  })

  it('shows the preview pane when a project has nothing at all', () => {
    const empty = docs({ plans: [], roadmap: null, sections: [], config: [] })
    expect(landingFor(empty, { group: 'plan' })).toEqual({ item: null, mode: 'view', atEnd: false })
  })
})
