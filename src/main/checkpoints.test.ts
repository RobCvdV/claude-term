import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RevertStep } from '../shared/types'
import { CheckpointStore } from './checkpoint-store'
import {
  dropCheckpoint,
  planRevert,
  relsWithin,
  revertFiles,
  takeCheckpoint,
  type Checkpoint
} from './checkpoints'

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' })

const repos: string[] = []

/** A repo with one committed file, one pre-existing untracked file. */
function newRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cp-')))
  repos.push(dir)
  run(dir, 'init', '-q', '.')
  run(dir, 'config', 'user.email', 't@t')
  run(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/tracked.ts'), 'const a = 1\n')
  writeFileSync(join(dir, 'src/untouched.ts'), 'const b = 2\n')
  run(dir, 'add', '-A')
  run(dir, 'commit', '-qm', 'init')
  writeFileSync(join(dir, 'notes.txt'), 'mine\n') // untracked, predates any turn
  return dir
}

afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true })
})

describe('planRevert', () => {
  const plan = (over: Partial<Parameters<typeof planRevert>[0]> = {}): RevertStep[] =>
    planRevert({
      rels: ['a.ts'],
      inBase: () => false,
      wasUntracked: () => false,
      existsNow: () => true,
      ...over
    })

  it('restores a file the checkpoint has', () => {
    expect(plan({ inBase: () => true })).toEqual([{ rel: 'a.ts', action: 'restore' }])
  })

  it('removes a file the turn created', () => {
    expect(plan()).toEqual([{ rel: 'a.ts', action: 'remove' }])
  })

  it('keeps an untracked file that predates the turn — its old text is nowhere', () => {
    expect(plan({ wasUntracked: () => true })).toEqual([{ rel: 'a.ts', action: 'keep' }])
  })

  it('keeps a file that is already gone', () => {
    expect(plan({ existsNow: () => false })).toEqual([{ rel: 'a.ts', action: 'keep' }])
  })
})

describe('relsWithin', () => {
  it('makes paths repo-relative and drops what is outside', () => {
    expect(relsWithin('/repo', ['/repo/src/a.ts', '/elsewhere/b.ts', '/repo'])).toEqual([
      'src/a.ts'
    ])
  })
})

describe('takeCheckpoint', () => {
  it('is null outside a repository', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'cp-plain-')))
    repos.push(plain)
    expect(await takeCheckpoint(plain, 'x')).toBeNull()
  })

  it('records the untracked files and leaves no trace in git', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'src/tracked.ts'), 'const a = 99\n')
    const cp = await takeCheckpoint(dir, 'id-1')
    expect(cp?.untracked).toEqual(['notes.txt'])
    expect(cp?.sha).toMatch(/^[0-9a-f]{40}$/)
    // the whole point of `stash create`: no stash entry, no index or worktree change
    expect(run(dir, 'stash', 'list').trim()).toBe('')
    expect(run(dir, 'status', '--porcelain')).toContain(' M src/tracked.ts')
  })

  it('keeps its commit alive with a ref, and lets go on drop', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'src/tracked.ts'), 'const a = 3\n')
    const cp = (await takeCheckpoint(dir, 'id-2')) as Checkpoint
    expect(run(dir, 'rev-parse', 'refs/claude-term/checkpoint/id-2').trim()).toBe(cp.sha)
    await dropCheckpoint(cp)
    expect(() => run(dir, 'rev-parse', 'refs/claude-term/checkpoint/id-2')).toThrow()
  })

  it('has no commit to pin when nothing tracked was modified', async () => {
    const dir = newRepo()
    const cp = await takeCheckpoint(dir, 'id-3')
    expect(cp?.sha).toBeNull()
    expect(cp?.ref).toBeNull()
  })
})

describe('revertFiles', () => {
  it('puts back a file the turn edited', async () => {
    const dir = newRepo()
    const cp = (await takeCheckpoint(dir, 'r-1')) as Checkpoint
    writeFileSync(join(dir, 'src/tracked.ts'), 'const a = "edited by the turn"\n')
    const result = await revertFiles(cp, [join(dir, 'src/tracked.ts')])
    expect(result.steps).toEqual([{ rel: 'src/tracked.ts', action: 'restore' }])
    expect(readFileSync(join(dir, 'src/tracked.ts'), 'utf8')).toBe('const a = 1\n')
  })

  it('restores from HEAD when the checkpoint had nothing to stash', async () => {
    const dir = newRepo()
    const cp = (await takeCheckpoint(dir, 'r-2')) as Checkpoint
    expect(cp.sha).toBeNull()
    writeFileSync(join(dir, 'src/tracked.ts'), 'broken\n')
    await revertFiles(cp, [join(dir, 'src/tracked.ts')])
    expect(readFileSync(join(dir, 'src/tracked.ts'), 'utf8')).toBe('const a = 1\n')
  })

  it('restores a mid-turn state, not the last commit', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'src/tracked.ts'), 'const a = 2 // my own edit\n')
    const cp = (await takeCheckpoint(dir, 'r-3')) as Checkpoint
    writeFileSync(join(dir, 'src/tracked.ts'), 'const a = 3 // the turn\n')
    await revertFiles(cp, [join(dir, 'src/tracked.ts')])
    // back to what the tree held when the turn started — my edit survives
    expect(readFileSync(join(dir, 'src/tracked.ts'), 'utf8')).toBe('const a = 2 // my own edit\n')
  })

  it('deletes a file the turn created', async () => {
    const dir = newRepo()
    const cp = (await takeCheckpoint(dir, 'r-4')) as Checkpoint
    writeFileSync(join(dir, 'src/new.ts'), 'const n = 1\n')
    const result = await revertFiles(cp, [join(dir, 'src/new.ts')])
    expect(result.steps).toEqual([{ rel: 'src/new.ts', action: 'remove' }])
    expect(existsSync(join(dir, 'src/new.ts'))).toBe(false)
  })

  it('never deletes an untracked file that predates the turn', async () => {
    const dir = newRepo()
    const cp = (await takeCheckpoint(dir, 'r-5')) as Checkpoint
    writeFileSync(join(dir, 'notes.txt'), 'the turn wrote over my notes\n')
    const result = await revertFiles(cp, [join(dir, 'notes.txt')])
    expect(result.steps).toEqual([{ rel: 'notes.txt', action: 'keep' }])
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('touches only the files it was given', async () => {
    const dir = newRepo()
    const cp = (await takeCheckpoint(dir, 'r-6')) as Checkpoint
    writeFileSync(join(dir, 'src/tracked.ts'), 'the turn\n')
    writeFileSync(join(dir, 'src/untouched.ts'), 'my own work\n')
    await revertFiles(cp, [join(dir, 'src/tracked.ts')])
    expect(readFileSync(join(dir, 'src/untouched.ts'), 'utf8')).toBe('my own work\n')
  })

  it('ignores a path outside the repository', async () => {
    const dir = newRepo()
    const cp = (await takeCheckpoint(dir, 'r-7')) as Checkpoint
    expect((await revertFiles(cp, ['/etc/passwd'])).steps).toEqual([])
  })

  it('restores bytes, not text', async () => {
    const dir = newRepo()
    const bin = join(dir, 'src/blob.bin')
    const original = Buffer.from([0, 1, 2, 250, 251, 252])
    writeFileSync(bin, original)
    run(dir, 'add', '-A')
    run(dir, 'commit', '-qm', 'binary')
    const cp = (await takeCheckpoint(dir, 'r-8')) as Checkpoint
    writeFileSync(bin, Buffer.from([9, 9, 9]))
    await revertFiles(cp, [bin])
    expect(readFileSync(bin).equals(original)).toBe(true)
  })
})

describe('CheckpointStore', () => {
  const cp = (at: number): Checkpoint => ({
    root: '/repo',
    sha: `sha-${at}`,
    untracked: [],
    at,
    ref: `refs/claude-term/checkpoint/${at}`
  })
  let evicted: Checkpoint[]
  let store: CheckpointStore

  beforeEach(() => {
    evicted = []
    store = new CheckpointStore((c) => evicted.push(c), 3)
  })

  it('hands back the newest as the point this turn started from', () => {
    store.add('t1', cp(1))
    store.add('t1', cp(2))
    expect(store.latest('t1')?.at).toBe(2)
    expect(store.latest('t2')).toBeNull()
  })

  it('finds the point a turn started from by time', () => {
    const t0 = 1_760_000_000_000
    for (const at of [t0, t0 + 600_000, t0 + 1_200_000]) store.add('t1', cp(at))
    // the transcript stamps the user message a moment after the hook fired
    expect(store.near('t1', t0 + 600_500)?.at).toBe(t0 + 600_000)
    // closest wins, not merely "within tolerance"
    expect(store.near('t1', t0 + 1_150_000)?.at).toBe(t0 + 1_200_000)
    // a turn from before this app run has none, and gets no false match
    expect(store.near('t1', t0 - 3_600_000)).toBeNull()
    expect(store.near('t2', t0)).toBeNull()
  })

  it('evicts the oldest past the cap, so its ref can be released', () => {
    for (const at of [1, 2, 3, 4, 5]) store.add('t1', cp(at))
    expect(store.count('t1')).toBe(3)
    expect(evicted.map((c) => c.at)).toEqual([1, 2])
    expect(store.latest('t1')?.at).toBe(5)
  })

  it('keeps tabs apart, and releases everything a closed tab held', () => {
    store.add('t1', cp(1))
    store.add('t2', cp(2))
    store.forget('t1')
    expect(evicted.map((c) => c.at)).toEqual([1])
    expect(store.latest('t1')).toBeNull()
    expect(store.latest('t2')?.at).toBe(2)
  })

  it('releases every tab on shutdown', () => {
    store.add('t1', cp(1))
    store.add('t2', cp(2))
    store.forgetAll()
    expect(evicted).toHaveLength(2)
    expect(store.count('t1')).toBe(0)
  })
})
