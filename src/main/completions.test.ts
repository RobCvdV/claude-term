import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { expandHome, listDirs, parseBranchRefs, searchFiles } from './completions'

let cwd: string
let tree: string

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'ct-completions-'))
  cwd = join(base, 'project')
  tree = join(base, 'tree')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(tree, 'sub-one'), { recursive: true })
  mkdirSync(join(tree, 'sub-two'), { recursive: true })
  writeFileSync(join(tree, 'file.txt'), 'x')
})

describe('expandHome', () => {
  it('expands ~ and ~/… to the home dir', () => {
    expect(expandHome('~', '/home/rob')).toBe('/home/rob/')
    expect(expandHome('~/Dev/x', '/home/rob')).toBe('/home/rob/Dev/x')
  })

  it('leaves non-home queries alone', () => {
    expect(expandHome('src/foo', '/home/rob')).toBeNull()
    expect(expandHome('~oddname', '/home/rob')).toBeNull()
    expect(expandHome('/abs', '/home/rob')).toBeNull()
  })
})

describe('searchFiles navigation (@ mentions)', () => {
  it('navigates an absolute path one level, dirs first with trailing /', async () => {
    const out = await searchFiles(cwd, tree + '/')
    expect(out).toEqual([tree + '/sub-one/', tree + '/sub-two/', tree + '/file.txt'])
  })

  it('filters the last segment of an absolute path', async () => {
    const out = await searchFiles(cwd, tree + '/sub-t')
    expect(out).toEqual([tree + '/sub-two/'])
  })

  it('completes from / (filesystem root)', async () => {
    const out = await searchFiles(cwd, '/')
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((p) => p.startsWith('/'))).toBe(true)
  })

  it('routes ~ to the home dir, returning absolute suggestions', async () => {
    const out = await searchFiles(cwd, '~')
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((p) => p.startsWith(homedir() + '/'))).toBe(true)
  })
})

describe('listDirs (~ support for /add-dir)', () => {
  it('lists only directories under an expanded ~ path', () => {
    // hermetic ~-equivalent: absolute navigation is the same code path the
    // expansion feeds into
    expect(listDirs(cwd, tree + '/')).toEqual([tree + '/sub-one/', tree + '/sub-two/'])
    const out = listDirs(cwd, '~/')
    expect(out.every((p) => p.startsWith(homedir() + '/') && p.endsWith('/'))).toBe(true)
  })
})

describe('parseBranchRefs', () => {
  const rows = [
    '*\tfeat/current\t<rob@mendrix.nl>',
    ' \tfeat/mine\t<rob@mendrix.nl>',
    ' \tfeat/theirs\t<colleague@mendrix.nl>',
    ' \tmain\t<ROB@Mendrix.nl>'
  ].join('\n')

  it('drops the checked-out branch and marks the ones the user wrote last', () => {
    expect(parseBranchRefs(rows, 'rob@mendrix.nl')).toEqual([
      { name: 'feat/mine', mine: true },
      { name: 'feat/theirs', mine: false },
      // git records the email as written; comparing is case-insensitive
      { name: 'main', mine: true }
    ])
  })

  it('claims nothing when the repo has no user.email configured', () => {
    expect(parseBranchRefs(rows, '').every((b) => b.mine)).toBe(false)
    expect(parseBranchRefs(rows, '   ').every((b) => b.mine)).toBe(false)
  })

  it('is empty for empty output, and skips blank lines', () => {
    expect(parseBranchRefs('', 'rob@mendrix.nl')).toEqual([])
    expect(parseBranchRefs('\n\n', 'rob@mendrix.nl')).toEqual([])
  })

  it('keeps a branch whose tip has no author recorded', () => {
    expect(parseBranchRefs(' \tfeat/x\t', 'rob@mendrix.nl')).toEqual([
      { name: 'feat/x', mine: false }
    ])
  })
})
