import { describe, expect, it } from 'vitest'
import {
  isWorkspaceRoot,
  resolveSwitchTarget,
  workspaceBranchChoices,
  workspaceBranchGroups
} from './branch-list'
import type { TabStatus } from '../shared/types'

function status(over: Partial<TabStatus> = {}): TabStatus {
  return {
    tabId: 't1',
    claudeActive: true,
    activity: 'idle',
    busySince: null,
    sessionId: null,
    exitCode: null,
    cwd: '/dev/cordova',
    addedDirs: [],
    removedDirs: [],
    payload: null,
    git: { ...gitInfo, branch: 'feature/MTX-1-a' },
    ci: null,
    extraRepos: [{ root: '/dev/mmxlib', git: { ...gitInfo, branch: 'main' }, ci: null }],
    ...over
  }
}

const gitInfo = {
  branch: '',
  changed: 0,
  unpushed: 0,
  behind: 0,
  remoteUrl: '',
  prUrl: null,
  pr: null,
  mergedPr: null,
  ticket: null,
  hasWorkflows: false
}

describe('isWorkspaceRoot', () => {
  it('accepts the tab cwd and extra repo roots (trailing slashes ignored)', () => {
    const st = status()
    expect(isWorkspaceRoot(st, '/dev/cordova')).toBe(true)
    expect(isWorkspaceRoot(st, '/dev/mmxlib/')).toBe(true)
  })

  it('rejects anything else, and everything for a null status', () => {
    expect(isWorkspaceRoot(status(), '/dev/elsewhere')).toBe(false)
    expect(isWorkspaceRoot(null, '/dev/cordova')).toBe(false)
  })
})

describe('workspaceBranchGroups', () => {
  // names in, BranchRefs out — the second name of each repo is "mine"
  const lister = (branches: Record<string, string[]>) => (cwd: string) =>
    Promise.resolve((branches[cwd] ?? []).map((name, i) => ({ name, mine: i === 1 })))

  it('groups the tab repo and every extra repo with their current branch', async () => {
    const groups = await workspaceBranchGroups(
      status(),
      lister({ '/dev/cordova': ['main', 'bugfix/MTX-2-b'], '/dev/mmxlib': ['feature/MTX-3-c'] })
    )
    expect(groups).toEqual([
      {
        root: '/dev/cordova',
        current: 'feature/MTX-1-a',
        branches: [
          { name: 'main', mine: false },
          { name: 'bugfix/MTX-2-b', mine: true }
        ]
      },
      {
        root: '/dev/mmxlib',
        current: 'main',
        branches: [{ name: 'feature/MTX-3-c', mine: false }]
      }
    ])
  })

  it('skips the tab folder when it is not a git repo', async () => {
    const groups = await workspaceBranchGroups(status({ git: null }), lister({}))
    expect(groups.map((g) => g.root)).toEqual(['/dev/mmxlib'])
  })

  it('returns [] for a null status', async () => {
    expect(await workspaceBranchGroups(null, lister({}))).toEqual([])
  })
})

describe('workspaceBranchChoices', () => {
  const lister = (branches: Record<string, string[]>) => (cwd: string) =>
    Promise.resolve((branches[cwd] ?? []).map((name) => ({ name, mine: false })))
  const list = lister({ '/dev/cordova': ['main', 'bugfix/MTX-2-b'], '/dev/mmxlib': ['MTX-2-c'] })

  it('lists the tab repo bare and extra repos as repo:branch', async () => {
    const keys = (await workspaceBranchChoices(status(), '/dev/cordova', list, '')).map(
      (c) => c.key
    )
    expect(keys).toEqual(['main', 'bugfix/MTX-2-b', 'mmxlib:MTX-2-c'])
  })

  it('filters on the whole key, so a repo name or ticket number finds it', async () => {
    const byRepo = await workspaceBranchChoices(status(), '/dev/cordova', list, 'mmx')
    expect(byRepo).toEqual([
      { key: 'mmxlib:MTX-2-c', branch: 'MTX-2-c', root: '/dev/mmxlib', repo: 'mmxlib' }
    ])
    const byTicket = await workspaceBranchChoices(status(), '/dev/cordova', list, 'MTX-2')
    expect(byTicket.map((c) => c.key)).toEqual(['bugfix/MTX-2-b', 'mmxlib:MTX-2-c'])
  })

  it('keeps extra repos visible unfiltered when the tab repo has many branches', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `b${i}`)
    const busy = lister({ '/dev/cordova': many, '/dev/mmxlib': ['MTX-2-c'] })
    const keys = (await workspaceBranchChoices(status(), '/dev/cordova', busy, '')).map(
      (c) => c.key
    )
    expect(keys).toContain('mmxlib:MTX-2-c')
  })
})

describe('resolveSwitchTarget', () => {
  it('sends repo:branch to the extra repo, anything else to cwd', () => {
    expect(resolveSwitchTarget(status(), '/dev/cordova', 'mmxlib:main')).toEqual({
      root: '/dev/mmxlib',
      branch: 'main',
      repo: 'mmxlib'
    })
    expect(resolveSwitchTarget(status(), '/dev/cordova', ' feature/x ')).toEqual({
      root: '/dev/cordova',
      branch: 'feature/x'
    })
    expect(resolveSwitchTarget(null, '/dev/cordova', 'mmxlib:main').root).toBe('/dev/cordova')
  })
})
