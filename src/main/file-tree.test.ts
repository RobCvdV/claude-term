import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { insideAny, listTree, treeRoots } from './file-tree'

let dir: string
let other: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tree-'))
  other = mkdtempSync(join(tmpdir(), 'tree-other-'))
  mkdirSync(join(dir, 'src/main'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, '.claude'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'empty'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# hi\n')
  writeFileSync(join(dir, '.gitignore'), '*.log\n')
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(join(dir, 'src/main/index.ts'), 'export {}\n')
  writeFileSync(join(dir, '.claude/settings.json'), '{}')
  writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'x')
  writeFileSync(join(other, 'outside.txt'), 'x')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

const names = (path: string): string[] => listTree([dir], path).map((n) => n.name)

describe('listTree', () => {
  it('lists folders before files, each alphabetically', () => {
    // .claude and docs are folders; the dotfile sorts with the files
    expect(names(dir)).toEqual([
      '.claude',
      'docs',
      'empty',
      'src',
      '.gitignore',
      'package.json',
      'README.md'
    ])
  })

  it('keeps dot-folders — .claude and .github are worth reaching', () => {
    expect(names(dir)).toContain('.claude')
    expect(listTree([dir], join(dir, '.claude')).map((n) => n.name)).toEqual(['settings.json'])
  })

  it('leaves out dependency and build folders', () => {
    expect(names(dir)).not.toContain('node_modules')
    expect(names(dir)).not.toContain('dist')
  })

  it('reads one level only — nothing recursive', () => {
    const src = listTree([dir], join(dir, 'src'))
    expect(src.map((n) => n.name)).toEqual(['main'])
    expect(src[0].isDir).toBe(true)
  })

  it('reports file sizes, and 0 for folders', () => {
    const entries = listTree([dir], dir)
    expect(entries.find((e) => e.name === 'README.md')?.size).toBe('# hi\n'.length)
    expect(entries.find((e) => e.name === 'docs')?.size).toBe(0)
  })

  it('is empty for a folder with nothing in it, and for an unreadable path', () => {
    expect(listTree([dir], join(dir, 'empty'))).toEqual([])
    expect(listTree([dir], join(dir, 'no-such-folder'))).toEqual([])
  })

  it('refuses a folder outside every root', () => {
    expect(listTree([dir], other)).toEqual([])
    expect(listTree([dir], join(dir, '..'))).toEqual([])
  })

  it('lists a folder that is itself a root', () => {
    expect(listTree([dir, other], other).map((n) => n.name)).toEqual(['outside.txt'])
  })
})

describe('insideAny', () => {
  it('accepts a root itself and anything under it', () => {
    expect(insideAny([dir], dir)).toBe(true)
    expect(insideAny([dir], join(dir, 'src/main/index.ts'))).toBe(true)
  })

  it('rejects anything outside, including a climb out', () => {
    expect(insideAny([dir], other)).toBe(false)
    expect(insideAny([dir], join(dir, '../escape'))).toBe(false)
  })

  it('is not fooled by a sibling whose name starts with a root’s name', () => {
    expect(insideAny([join(dir, 'src')], join(dir, 'src-other/file.ts'))).toBe(false)
  })
})

describe('treeRoots', () => {
  it('puts the tab’s own folder first, then each added directory', () => {
    const roots = treeRoots(dir, [other])
    expect(roots.map((r) => r.path)).toEqual([dir, other])
    expect(roots[0].subtitle).toBeUndefined()
    // an added root can share a folder name, so it carries its full path
    expect(roots[1].subtitle).toBe(other)
  })

  it('drops an added directory that is already inside another root', () => {
    expect(treeRoots(dir, [join(dir, 'src')]).map((r) => r.path)).toEqual([dir])
  })

  it('drops a missing directory, and a file passed as one', () => {
    expect(treeRoots(dir, [join(dir, 'no-such-dir')]).map((r) => r.path)).toEqual([dir])
    expect(treeRoots(dir, [join(dir, 'README.md')]).map((r) => r.path)).toEqual([dir])
  })
})

describe('symlinks', () => {
  it('leaves links out rather than offering a folder it would refuse to open', () => {
    const link = join(dir, 'escape-link')
    try {
      symlinkSync(other, link)
    } catch {
      return // no permission to symlink here; nothing to assert
    }
    expect(names(dir)).not.toContain('escape-link')
    // and the place it pointed at stays out of reach on its own account
    expect(listTree([dir], other)).toEqual([])
    rmSync(link, { force: true })
  })
})
