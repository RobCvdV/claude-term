import { describe, expect, it } from 'vitest'
import {
  actionsUrl,
  branchUrl,
  circleCiUrl,
  isTrunkBranch,
  parseRemote,
  releasesUrl
} from './repo-links'

describe('parseRemote', () => {
  it('reads ssh and https bitbucket remotes', () => {
    const expected = { host: 'bitbucket', owner: 'mendrixmobile', repo: 'mendrix-mobile-next' }
    expect(parseRemote('git@bitbucket.org:mendrixmobile/mendrix-mobile-next.git')).toEqual(expected)
    expect(parseRemote('https://bitbucket.org/mendrixmobile/mendrix-mobile-next')).toEqual(expected)
    expect(
      parseRemote('https://user@bitbucket.org/mendrixmobile/mendrix-mobile-next.git/')
    ).toEqual(expected)
  })

  it('reads github remotes', () => {
    expect(parseRemote('git@github.com:RobCvdV/claude-term.git')).toEqual({
      host: 'github',
      owner: 'RobCvdV',
      repo: 'claude-term'
    })
  })

  it('returns null for other hosts and empty input', () => {
    expect(parseRemote('git@gitlab.com:foo/bar.git')).toBeNull()
    expect(parseRemote('')).toBeNull()
  })
})

describe('branch links', () => {
  const bb = parseRemote('git@bitbucket.org:mendrixmobile/mendrix-mobile-next.git')!
  const gh = parseRemote('git@github.com:RobCvdV/claude-term.git')!

  it('links a branch on both hosts', () => {
    expect(branchUrl(bb, 'bugfix/MTX-10413-x')).toBe(
      'https://bitbucket.org/mendrixmobile/mendrix-mobile-next/branch/bugfix%2FMTX-10413-x'
    )
    expect(branchUrl(gh, 'feature/foo')).toBe(
      'https://github.com/RobCvdV/claude-term/tree/feature%2Ffoo'
    )
  })

  it('gives CircleCI only for the mobile repos', () => {
    expect(circleCiUrl(bb, 'bugfix/MTX-10413-workhours-bugs')).toBe(
      'https://app.circleci.com/pipelines/bitbucket/mendrixmobile?filter=branch:equals:bugfix/MTX-10413-workhours-bugs&useNewPipelines=true'
    )
    expect(circleCiUrl(parseRemote('git@bitbucket.org:mendrix/mendrix-tms.git')!, 'x')).toBeNull()
    expect(circleCiUrl(gh, 'x')).toBeNull()
  })

  it('gives Actions and Releases only for github', () => {
    expect(actionsUrl(gh, 'main')).toBe(
      'https://github.com/RobCvdV/claude-term/actions?query=branch%3Amain'
    )
    expect(releasesUrl(gh)).toBe('https://github.com/RobCvdV/claude-term/releases')
    expect(actionsUrl(bb, 'main')).toBeNull()
    expect(releasesUrl(bb)).toBeNull()
  })
})

describe('isTrunkBranch', () => {
  it('skips PR lookups on trunk and detached HEAD', () => {
    expect(isTrunkBranch('main')).toBe(true)
    expect(isTrunkBranch('HEAD')).toBe(true)
    expect(isTrunkBranch('bugfix/MTX-1')).toBe(false)
  })
})
