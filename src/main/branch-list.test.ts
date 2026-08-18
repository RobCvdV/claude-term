import { describe, expect, it } from 'vitest'
import { isWorkspaceRoot, workspaceBranchGroups } from './branch-list'
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
