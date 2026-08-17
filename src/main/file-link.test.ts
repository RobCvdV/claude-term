import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { resolveFileLink } from './file-link'

let root: string
let added: string
let outside: string
let home: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'link-root-'))
  added = mkdtempSync(join(tmpdir(), 'link-added-'))
  outside = mkdtempSync(join(tmpdir(), 'link-out-'))
  home = mkdtempSync(join(tmpdir(), 'link-home-'))
  mkdirSync(join(root, 'src/main'), { recursive: true })
  writeFileSync(join(root, 'src/main/ipc.ts'), 'x\n')
  writeFileSync(join(root, 'README.md'), 'x\n')
  writeFileSync(join(added, 'notes.md'), 'x\n')
  writeFileSync(join(outside, 'secret.txt'), 'x\n')
  mkdirSync(join(home, 'dev'), { recursive: true })
  writeFileSync(join(home, 'dev/n.md'), 'x\n')
})

afterAll(() => {
  for (const d of [root, added, outside, home]) rmSync(d, { recursive: true, force: true })
})

const roots = (): string[] => [root, added]

describe('resolveFileLink', () => {
  it('resolves a path relative to the tab cwd, keeping line and column', () => {
    expect(resolveFileLink(roots(), { path: 'src/main/ipc.ts', line: 403, column: 7 })).toEqual({
      path: resolve(root, 'src/main/ipc.ts'),
      line: 403,
      column: 7
    })
  })

  it('falls through to an added directory when the cwd has no such file', () => {
    expect(resolveFileLink(roots(), { path: 'notes.md', line: 2 })?.path).toBe(
      resolve(added, 'notes.md')
    )
  })

  it('takes an absolute path that is inside a root', () => {
    const path = join(root, 'README.md')
    expect(resolveFileLink(roots(), { path, line: 1 })?.path).toBe(resolve(path))
  })

  it('expands ~ against the home directory', () => {
    expect(resolveFileLink([home], { path: '~/dev/n.md', line: 1 }, home)?.path).toBe(
      resolve(home, 'dev/n.md')
    )
  })

  it('refuses a path outside every root', () => {
    expect(resolveFileLink(roots(), { path: join(outside, 'secret.txt'), line: 1 })).toBeNull()
    expect(resolveFileLink(roots(), { path: '../../etc/passwd', line: 1 })).toBeNull()
  })

  it('refuses a directory and a file that is not there', () => {
    expect(resolveFileLink(roots(), { path: 'src/main', line: 1 })).toBeNull()
    expect(resolveFileLink(roots(), { path: 'src/main/gone.ts', line: 1 })).toBeNull()
  })

  it('refuses a ~ path that lands outside the roots', () => {
    expect(resolveFileLink(roots(), { path: '~/dev/n.md', line: 1 }, home)).toBeNull()
  })
})
