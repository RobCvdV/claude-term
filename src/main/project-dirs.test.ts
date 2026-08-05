import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settingsAddedDirs } from './project-dirs'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ct-proj-'))
  mkdirSync(join(cwd, '.claude'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const write = (file: string, content: unknown): void =>
  writeFileSync(join(cwd, '.claude', file), JSON.stringify(content))

describe('settingsAddedDirs', () => {
  it('reads additionalDirectories from both settings files, deduped', () => {
    write('settings.json', { permissions: { additionalDirectories: ['/a', '/b'] } })
    write('settings.local.json', { permissions: { additionalDirectories: ['/b', '/c'] } })
    expect(settingsAddedDirs(cwd)).toEqual(['/a', '/b', '/c'])
  })

  it('expands ~ and resolves relative paths against the project', () => {
    write('settings.local.json', {
      permissions: { additionalDirectories: ['~/Dev/mmxlib', '../sibling'] }
    })
    expect(settingsAddedDirs(cwd)).toEqual([
      join(homedir(), 'Dev/mmxlib'),
      join(cwd, '..', 'sibling')
    ])
  })

  it('tolerates missing files, invalid JSON, and wrong shapes', () => {
    expect(settingsAddedDirs(cwd)).toEqual([])
    writeFileSync(join(cwd, '.claude', 'settings.json'), '// comment\n{}')
    write('settings.local.json', { permissions: { additionalDirectories: 'nope' } })
    expect(settingsAddedDirs(cwd)).toEqual([])
  })
})
