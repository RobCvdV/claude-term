import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listConfigFiles, readPatterns, resolveRoots } from './config-files'
import { MAX_EDIT_BYTES } from '../shared/types'

let dir: string
let patternsFile: string
let added: string
let outside: string

function file(path: string, content = 'x'): void {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'claude-term-config-'))
  dir = join(base, 'project')
  added = join(base, 'extra')
  outside = join(base, 'elsewhere')
  patternsFile = join(base, 'config-file-patterns.json')
  mkdirSync(dir, { recursive: true })
  mkdirSync(added, { recursive: true })
  mkdirSync(outside, { recursive: true })

  // root level (scanned, but NOT recursively)
  file('package.json')
  file('package-lock.json')
  file('tsconfig.json')
  file('.gitignore')
  file('Dockerfile')
  file('gradle.properties')
  file('MyApp.dproj')
  file('electron.vite.config.ts')
  file('README.md')
  file('logo.png')
  // an ordinary sub-folder: not walked, so its config stays hidden
  file('src/deep.json')
  // test folders: walked in full
  file('test/a.json')
  file('test/nested/b.yml')
  file('test-api/TestApi.dproj')
  // dot-folders: walked in full, and markdown counts inside them
  file('.claude/settings.json')
  file('.claude/agents/reviewer.md')
  file('.github/workflows/release.yml')
  // never walked
  file('node_modules/dep/package.json')
  file('dist/bundle.json')
  file('__history/MyApp.dproj')

  writeFileSync(join(added, 'app.json'), '{}')
  writeFileSync(join(outside, 'secrets.json'), 'nope')
})

afterAll(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

/** Every listed path, relative to the project root. */
function relsOf(addedDirs: string[] = []): string[] {
  const listed = listConfigFiles(dir, addedDirs, patternsFile)
  const section = listed.sections.find((s) => s.root === dir)
  return (section?.entries ?? []).map((e) => e.rel)
}

describe('listConfigFiles', () => {
  it('lists config files in the root but does not recurse into ordinary folders', () => {
    const rels = relsOf()
    expect(rels).toContain('package.json')
    expect(rels).toContain('tsconfig.json')
    expect(rels).toContain('.gitignore')
    expect(rels).toContain('Dockerfile')
    expect(rels).toContain('gradle.properties')
    expect(rels).toContain('MyApp.dproj')
    expect(rels).toContain('electron.vite.config.ts')
    // src/ is neither a test folder nor a dot-folder — a monorepo would otherwise
    // bury the root's own config under every package's
    expect(rels).not.toContain('src/deep.json')
  })

  it('recurses into test folders and dot-folders', () => {
    const rels = relsOf()
    expect(rels).toContain('test/a.json')
    expect(rels).toContain('test/nested/b.yml')
    expect(rels).toContain('test-api/TestApi.dproj')
    expect(rels).toContain('.claude/settings.json')
    expect(rels).toContain('.github/workflows/release.yml')
  })

  it('counts markdown only inside dot-folders — project docs are the Docs window', () => {
    const rels = relsOf()
    expect(rels).toContain('.claude/agents/reviewer.md')
    expect(rels).not.toContain('README.md')
  })

  it('excludes generated files that match an include pattern', () => {
    // package-lock.json is a *.json in every node project and is pure noise
    expect(relsOf()).not.toContain('package-lock.json')
  })

  it('skips dependency, build-output and Delphi backup folders', () => {
    const rels = relsOf()
    expect(rels.some((r) => r.startsWith('node_modules/'))).toBe(false)
    expect(rels.some((r) => r.startsWith('dist/'))).toBe(false)
    expect(rels.some((r) => r.startsWith('__history/'))).toBe(false)
  })

  it('ignores files that are not configuration', () => {
    expect(relsOf()).not.toContain('logo.png')
  })

  it('gives each added directory its own section, and always lists the cwd first', () => {
    const listed = listConfigFiles(dir, [added], patternsFile)
    const roots = listed.sections.map((s) => s.root)
    expect(roots[0]).toBe(dir)
    expect(roots).toContain(added)
    const extra = listed.sections.find((s) => s.root === added)
    expect(extra?.entries.map((e) => e.rel)).toEqual(['app.json'])
    // the cwd section is the tab's own project, so it carries no path subtitle
    expect(listed.sections[0].subtitle).toBeUndefined()
    expect(extra?.subtitle).toBe(added)
  })

  it('lists its own patterns file so it can be edited in the same window', () => {
    const listed = listConfigFiles(dir, [], patternsFile)
    const own = listed.sections.find((s) => s.name === 'claude-term')
    expect(own?.entries.map((e) => e.path)).toEqual([patternsFile])
    expect(listed.patternsFile).toBe(patternsFile)
  })

  it('honours user include and exclude patterns, with exclude winning', () => {
    writeFileSync(
      patternsFile,
      JSON.stringify({ include: ['*.png'], exclude: ['tsconfig.json', '*.dproj'] })
    )
    const rels = relsOf()
    expect(rels).toContain('logo.png')
    expect(rels).not.toContain('tsconfig.json')
    expect(rels).not.toContain('MyApp.dproj')
    // exclude beats include, even when the user asked for both
    writeFileSync(patternsFile, JSON.stringify({ include: ['*.png'], exclude: ['*.png'] }))
    expect(relsOf()).not.toContain('logo.png')
    writeFileSync(patternsFile, JSON.stringify({ include: [], exclude: [] }))
  })

  it('reports sizes, so the window can refuse to open a huge file', () => {
    const listed = listConfigFiles(dir, [], patternsFile)
    const pkg = listed.sections[0].entries.find((e) => e.rel === 'package.json')
    expect(pkg?.size).toBeGreaterThan(0)
    expect(pkg!.size).toBeLessThan(MAX_EDIT_BYTES)
  })
})

describe('readPatterns', () => {
  it('falls back to no extra patterns when the file is missing or malformed', () => {
    expect(readPatterns(join(dir, 'nope.json'))).toEqual({ include: [], exclude: [] })
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    expect(readPatterns(broken)).toEqual({ include: [], exclude: [] })
  })

  it('drops non-string entries rather than trusting the file', () => {
    const mixed = join(dir, 'mixed.json')
    writeFileSync(mixed, JSON.stringify({ include: ['*.a', 3, null], exclude: 'nope' }))
    expect(readPatterns(mixed)).toEqual({ include: ['*.a'], exclude: [] })
  })
})

describe('resolveRoots', () => {
  it('drops added dirs already covered by an earlier root, to avoid duplicates', () => {
    expect(resolveRoots(dir, [join(dir, 'test')])).toEqual([dir])
  })

  it('drops added dirs that do not exist or are not directories', () => {
    expect(resolveRoots(dir, [join(dir, 'gone'), join(dir, 'package.json')])).toEqual([dir])
  })

  it('de-duplicates repeated added dirs', () => {
    expect(resolveRoots(dir, [added, added])).toEqual([dir, added])
  })
})
