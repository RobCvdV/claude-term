import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { canonical, changedFiles, fileAtHead, repoRoot } from './git-diff'

let repo: string
let plain: string

const run = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

beforeAll(() => {
  // realpath: on macOS the temp dir is a symlink, and git reports resolved paths
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'diff-repo-')))
  plain = realpathSync(mkdtempSync(join(tmpdir(), 'diff-plain-')))
  run(repo, 'init', '-q', '.')
  run(repo, 'config', 'user.email', 't@t')
  run(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/keep.ts'), 'a\nb\nc\n')
  writeFileSync(join(repo, 'gone.ts'), 'del\n')
  writeFileSync(join(repo, 'with space.ts'), 'x\n')
  run(repo, 'add', '-A')
  run(repo, 'commit', '-qm', 'init')
  // …then dirty the tree in every way the rail has to render
  writeFileSync(join(repo, 'src/keep.ts'), 'a\nB\nc\nd\n')
  rmSync(join(repo, 'gone.ts'))
  writeFileSync(join(repo, 'with space.ts'), 'y\ny\n')
  writeFileSync(join(repo, 'fresh.ts'), 'new\n')
})

afterAll(() => {
  for (const d of [repo, plain]) rmSync(d, { recursive: true, force: true })
})

const byRel = async (): Promise<
  Record<string, { kind: string; added: number; removed: number }>
> => {
  const out: Record<string, { kind: string; added: number; removed: number }> = {}
  for (const f of await changedFiles(repo)) {
    out[f.rel] = { kind: f.kind, added: f.added, removed: f.removed }
  }
  return out
}

describe('canonical', () => {
  it('resolves a symlinked folder, the way git reports it', () => {
    const link = join(plain, 'link')
    symlinkSync(repo, link)
    expect(canonical(join(link, 'src/keep.ts'))).toBe(join(repo, 'src/keep.ts'))
  })

  it('keeps segments that are not there, so a deleted file still resolves', () => {
    expect(canonical(join(repo, 'never/was.ts'))).toBe(join(repo, 'never/was.ts'))
  })
})

describe('repoRoot', () => {
  it('finds the repository from a subfolder', async () => {
    expect(await repoRoot(join(repo, 'src'))).toBe(repo)
  })

  it('is null outside a repository', async () => {
    expect(await repoRoot(plain)).toBeNull()
  })
})

describe('changedFiles', () => {
  it('reports a modification with git’s own line counts', async () => {
    expect((await byRel())['src/keep.ts']).toEqual({ kind: 'modified', added: 2, removed: 1 })
  })

  it('reports a deletion and an untracked file', async () => {
    const all = await byRel()
    expect(all['gone.ts']).toEqual({ kind: 'deleted', added: 0, removed: 1 })
    expect(all['fresh.ts']).toMatchObject({ kind: 'untracked' })
  })

  it('handles a path with a space in it', async () => {
    expect((await byRel())['with space.ts']).toEqual({
      kind: 'modified',
      added: 2,
      removed: 1
    })
  })

  it('gives absolute paths, rooted at the repository', async () => {
    const hit = (await changedFiles(repo)).find((f) => f.rel === 'src/keep.ts')
    expect(hit?.path).toBe(join(repo, 'src/keep.ts'))
  })

  it('works the same from a subfolder of the repository', async () => {
    const fromSub = (await changedFiles(join(repo, 'src'))).map((f) => f.rel).sort()
    const fromRoot = (await changedFiles(repo)).map((f) => f.rel).sort()
    expect(fromSub).toEqual(fromRoot)
  })

  it('is empty outside a repository', async () => {
    expect(await changedFiles(plain)).toEqual([])
  })
})

describe('fileAtHead', () => {
  it('reads the committed side of a modified file', async () => {
    expect(await fileAtHead(repo, join(repo, 'src/keep.ts'))).toBe('a\nb\nc\n')
  })

  it('reads a deleted file, which only HEAD still has', async () => {
    expect(await fileAtHead(repo, join(repo, 'gone.ts'))).toBe('del\n')
  })

  it('is null for a file HEAD never had', async () => {
    expect(await fileAtHead(repo, join(repo, 'fresh.ts'))).toBeNull()
  })

  it('refuses a path outside the repository', async () => {
    expect(await fileAtHead(repo, join(plain, 'x.ts'))).toBeNull()
  })
})
