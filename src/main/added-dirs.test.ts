import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import {
  addedDirFromPrompt,
  additionalDirectoriesFromSettings,
  mergeAddedDirs,
  resolveAddedDir
} from './added-dirs'

let base: string
let cwd: string
let sibling: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'claude-term-added-'))
  cwd = join(base, 'project')
  sibling = join(base, 'library')
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  mkdirSync(join(cwd, 'packages', 'ui'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('addedDirFromPrompt', () => {
  it('extracts an absolute path', () => {
    expect(addedDirFromPrompt('/add-dir /tmp/foo', cwd)).toBe('/tmp/foo')
  })

  it('resolves a relative path against the tab cwd', () => {
    expect(addedDirFromPrompt('/add-dir packages/ui', cwd)).toBe(join(cwd, 'packages', 'ui'))
  })

  it('expands a leading ~', () => {
    expect(addedDirFromPrompt('/add-dir ~/Dev/x', cwd)).toBe(join(homedir(), 'Dev', 'x'))
    expect(addedDirFromPrompt('/add-dir ~', cwd)).toBe(homedir())
  })

  it('strips surrounding quotes, as typed for a path with spaces', () => {
    expect(addedDirFromPrompt('/add-dir "/tmp/my folder"', cwd)).toBe('/tmp/my folder')
    expect(addedDirFromPrompt("/add-dir '/tmp/other one'", cwd)).toBe('/tmp/other one')
  })

  it('tolerates surrounding whitespace', () => {
    expect(addedDirFromPrompt('   /add-dir   /tmp/foo   ', cwd)).toBe('/tmp/foo')
  })

  it('normalises away . and .. segments', () => {
    expect(addedDirFromPrompt('/add-dir ./packages/../packages/ui', cwd)).toBe(
      join(cwd, 'packages', 'ui')
    )
  })

  it('only reads the first line — a later line is a separate message, not a path', () => {
    expect(addedDirFromPrompt('/add-dir /tmp/foo\nand now do something', cwd)).toBe('/tmp/foo')
  })

  it('ignores anything that is not an /add-dir command', () => {
    expect(addedDirFromPrompt('please /add-dir /tmp/foo', cwd)).toBeNull()
    expect(addedDirFromPrompt('/add-dirs /tmp/foo', cwd)).toBeNull()
    expect(addedDirFromPrompt('/add-dir', cwd)).toBeNull()
    expect(addedDirFromPrompt('/add-dir   ', cwd)).toBeNull()
    expect(addedDirFromPrompt('/switch main', cwd)).toBeNull()
    expect(addedDirFromPrompt('', cwd)).toBeNull()
  })
})

describe('resolveAddedDir', () => {
  it('returns null for an empty argument', () => {
    expect(resolveAddedDir('   ', cwd)).toBeNull()
    expect(resolveAddedDir('""', cwd)).toBeNull()
  })
})

describe('additionalDirectoriesFromSettings', () => {
  it('reads permissions.additionalDirectories from the project settings', () => {
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: [sibling, 'packages/ui'] } })
    )
    const dirs = additionalDirectoriesFromSettings(cwd)
    expect(dirs).toContain(sibling)
    expect(dirs).toContain('packages/ui')
  })

  it('survives a malformed settings file — a broken file must not break the window', () => {
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{ oops')
    expect(() => additionalDirectoriesFromSettings(cwd)).not.toThrow()
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: {} }))
    expect(additionalDirectoriesFromSettings(cwd)).not.toContain(sibling)
  })

  it('ignores a non-array or non-string value', () => {
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: 'nope' } })
    )
    expect(additionalDirectoriesFromSettings(cwd)).toEqual([])
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: [sibling, 7, null] } })
    )
    expect(additionalDirectoriesFromSettings(cwd)).toEqual([sibling])
  })
})

describe('mergeAddedDirs', () => {
  beforeAll(() => {
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: [sibling] } })
    )
  })

  it('merges observed /add-dir folders with the settings chain', () => {
    const merged = mergeAddedDirs(cwd, [join(cwd, 'packages', 'ui')])
    expect(merged).toContain(join(cwd, 'packages', 'ui'))
    expect(merged).toContain(sibling)
  })

  it('puts observed folders first, so the rail order follows what you just added', () => {
    const observed = join(cwd, 'packages', 'ui')
    const merged = mergeAddedDirs(cwd, [observed])
    expect(merged.indexOf(observed)).toBeLessThan(merged.indexOf(sibling))
  })

  it('de-duplicates a folder present in both sources', () => {
    const merged = mergeAddedDirs(cwd, [sibling])
    expect(merged.filter((d) => d === sibling)).toHaveLength(1)
  })

  it('drops folders that no longer exist', () => {
    expect(mergeAddedDirs(cwd, [join(base, 'deleted')])).not.toContain(join(base, 'deleted'))
  })

  it('resolves relative settings entries against the cwd', () => {
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: ['packages/ui'] } })
    )
    expect(mergeAddedDirs(cwd, [])).toContain(join(cwd, 'packages', 'ui'))
  })

  it('leaves out a removed folder, settings-sourced ones included', () => {
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: [sibling] } })
    )
    const observed = join(cwd, 'packages', 'ui')
    expect(mergeAddedDirs(cwd, [observed], [observed])).not.toContain(observed)
    // the settings chain would otherwise hand it back on every call
    expect(mergeAddedDirs(cwd, [], [sibling])).not.toContain(sibling)
  })
})
