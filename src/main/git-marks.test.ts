import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gitMarks, parseMarks } from './git-marks'

let repo: string

const run = (...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
}

beforeAll(() => {
  // deliberately not realpath'd: on macOS tmpdir is a symlink, and the marks
  // must come back in the spelling the tree uses
  repo = mkdtempSync(join(tmpdir(), 'marks-'))
  run('init', '-q', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  mkdirSync(join(repo, 'src/deep'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  writeFileSync(join(repo, 'src/deep/keep.ts'), 'a\n')
  writeFileSync(join(repo, 'src/clean.ts'), 'a\n')
  run('add', '-A')
  run('commit', '-qm', 'init')
  writeFileSync(join(repo, 'src/deep/keep.ts'), 'b\n')
  writeFileSync(join(repo, 'staged.ts'), 'x\n')
  run('add', 'staged.ts')
  mkdirSync(join(repo, 'newdir'))
  writeFileSync(join(repo, 'newdir/a.ts'), 'x\n')
  mkdirSync(join(repo, 'dist'))
  writeFileSync(join(repo, 'dist/out.js'), 'x\n')
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('parseMarks', () => {
  it('reads each kind and skips a rename’s old path', () => {
    const out = [
      ' M a.ts',
      'A  b.ts',
      '?? new/',
      '!! dist/',
      'R  c.ts',
      'old.ts',
      'UU d.ts',
      ' D e.ts',
      ''
    ]
    expect(Object.fromEntries(parseMarks(out.join('\0')))).toEqual({
      'a.ts': 'modified',
      'b.ts': 'added',
      new: 'untracked',
      dist: 'ignored',
      'c.ts': 'modified',
      'd.ts': 'conflict',
      'e.ts': null
    })
  })
})

describe('gitMarks', () => {
  it('marks files and folders under the root, in its own spelling', async () => {
    const m = await gitMarks([repo])
    expect(m.exact).toEqual({
      [join(repo, 'src/deep/keep.ts')]: 'modified',
      [join(repo, 'staged.ts')]: 'added',
      [join(repo, 'newdir')]: 'untracked',
      [join(repo, 'dist')]: 'ignored'
    })
    expect(new Set(m.dirty)).toEqual(new Set([repo, join(repo, 'src'), join(repo, 'src/deep')]))
  })

  it('reports nothing outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'marks-plain-'))
    expect(await gitMarks([plain])).toEqual({ exact: {}, dirty: [] })
    rmSync(plain, { recursive: true, force: true })
  })
})
