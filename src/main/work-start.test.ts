import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BoardPr, TabStatus, WorkItem } from '../shared/types'
import {
  addWorktree,
  cloneState,
  isWorktree,
  listWorktrees,
  planStart,
  removeWorktree
} from './work-start'

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

describe('planStart', () => {
  const sure = (): WorkItem => ({ ...item, starts: [start()] }) as WorkItem
  it('resumes when the branch has a conversation, else starts new', async () => {
    await cloneState(item, start(), []) // plans read git state cached by the last check
    expect(await planStart(sure(), [], async () => true)).toEqual({
      kind: 'resume',
      root: repo,
      takeover: false
    })
    expect(await planStart(sure(), [tab({})], async () => false)).toEqual({
      kind: 'new',
      root: repo,
      takeover: true
    })
  })

  it('asks when the clone is not sure or busy', async () => {
    const unsure = (): WorkItem => ({ ...item, starts: [{ ...start(), sure: false }] }) as WorkItem
    expect(await planStart(unsure(), [], async () => false)).toEqual({ kind: 'choose' })
    expect((await planStart(sure(), [tab({ activity: 'busy' })], async () => false))?.kind).toBe(
      'choose'
    )
  })
})

describe('listWorktrees / removeWorktree', () => {
  it('a ticket worktree whose ticket left my work can go, and is removed', async () => {
    git('branch', 'bugfix/MTX-1-x')
    const ticket = { kind: 'pr', ticket: null, prs: [{ ...pr, branch: 'bugfix/MTX-1-x' }] }
    const wt = await addWorktree(ticket as unknown as WorkItem, repo)
    if (!wt.ok) throw new Error(wt.error)
    const ref = { host: 'github' as const, owner: 'me', repo: 'app' }
    const repos = [
      { root: repo, ref },
      { root: wt.start.root, ref }
    ]
    const [listed] = await listWorktrees(repos, [], new Set(), new Set())
    expect(listed).toMatchObject({
      repo: 'app',
      branch: 'bugfix/MTX-1-x',
      stale: 'MTX-1 is no longer in your work',
      dirty: false,
      inUse: false
    })
    const open = await listWorktrees(repos, [], new Set(['bugfix/MTX-1-x']), new Set())
    expect(open[0].stale).toBe(null)
    expect(await removeWorktree(wt.start.root)).toEqual({ ok: true })
    expect(existsSync(wt.start.root)).toBe(false)
    expect(git('branch', '--list', 'bugfix/MTX-1-x')).toContain('bugfix/MTX-1-x')
  })
})
