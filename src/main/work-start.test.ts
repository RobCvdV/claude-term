import { execFileSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BoardPr, TabStatus, WorkItem } from '../shared/types'
import { addWorktree, cloneState, isWorktree } from './work-start'

let dir: string
let repo: string
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'work-start-')))
  repo = join(dir, 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('branch', 'feature/x')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const pr = { branch: 'feature/x', url: 'https://github.com/me/app/pull/1' } as BoardPr
const item = { kind: 'pr', ticket: null, prs: [pr] } as unknown as WorkItem
const start = (): { root: string; branch: string; sure: boolean } => ({
  root: repo,
  branch: 'feature/x',
  sure: true
})
const tab = (over: Partial<TabStatus>): TabStatus =>
  ({
    tabId: 't1',
    cwd: repo,
    claudeActive: true,
    activity: 'idle',
    git: { branch: 'main' },
    extraRepos: [],
    ...over
  }) as TabStatus

describe('cloneState', () => {
  it('a clone without tabs is free; with its own idle tab, that tab is taken over', async () => {
    expect(await cloneState(item, start(), [])).toEqual({ kind: 'free' })
    expect(await cloneState(item, start(), [tab({})])).toEqual({ kind: 'takeover', tabId: 't1' })
  })

  it('a working tab, or uncommitted changes on another branch, keep it busy', async () => {
    expect((await cloneState(item, start(), [tab({ activity: 'busy' })])).kind).toBe('busy')
    writeFileSync(join(repo, 'wip.txt'), 'x')
    try {
      expect(await cloneState(item, start(), [])).toEqual({
        kind: 'busy',
        why: 'uncommitted changes on main'
      })
    } finally {
      rmSync(join(repo, 'wip.txt'))
    }
  })

  it('a tab already on the branch is the place to go', async () => {
    const on = tab({ activity: 'busy', git: { branch: 'feature/x' } as TabStatus['git'] })
    expect(await cloneState(item, start(), [on])).toEqual({ kind: 'here', tabId: 't1' })
  })
})

describe('addWorktree', () => {
  it('checks the PR branch out next to the repo, once', async () => {
    const res = await addWorktree(item, repo)
    expect(res).toEqual({
      ok: true,
      start: { root: join(dir, '.worktrees', 'app', 'feature-x'), branch: 'feature/x', sure: true }
    })
    if (!res.ok) return
    expect(isWorktree(res.start.root)).toBe(true)
    expect(
      execFileSync('git', ['-C', res.start.root, 'branch', '--show-current']).toString().trim()
    ).toBe('feature/x')
    expect(await addWorktree(item, repo)).toEqual(res)
  })
})
