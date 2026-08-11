import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseReflog, reflogBranches } from './branch-backfill'

describe('parseReflog', () => {
  const output = [
    'HEAD@{1786439369} commit: feat: something',
    'HEAD@{1786374508} checkout: moving from main to feature/MTX-2-b',
    'HEAD@{1786367883} checkout: moving from bugfix/MTX-1-a to main',
    'HEAD@{1786367851} checkout: moving from main to bugfix/MTX-1-a',
    'HEAD@{1786367000} checkout: moving from feature/MTX-2-b to main',
    'HEAD@{1786366000} checkout: moving from a1b2c3d to main'
  ].join('\n')

  it('captures both sides of a checkout, keeping the newest time per branch', () => {
    const byBranch = Object.fromEntries(parseReflog(output).map((e) => [e.branch, e.lastUsed]))
    expect(byBranch['feature/MTX-2-b']).toBe(1786374508000)
    expect(byBranch['bugfix/MTX-1-a']).toBe(1786367883000)
    expect(byBranch['main']).toBe(1786374508000)
  })

  it('skips detached-checkout hashes and non-checkout entries', () => {
    const branches = parseReflog(output).map((e) => e.branch)
    expect(branches).not.toContain('a1b2c3d')
    expect(branches).toHaveLength(3)
  })

  it('returns nothing for empty output', () => {
    expect(parseReflog('')).toEqual([])
  })
})

describe('reflogBranches (real git)', () => {
  it('recovers branches checked out in a repo, and [] for a non-repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-term-reflog-'))
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        stdio: 'ignore'
      })
    }
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('checkout', '-q', '-b', 'feature/MTX-9-x')
    git('checkout', '-q', 'main')
    const branches = (await reflogBranches(dir)).map((e) => e.branch)
    expect(branches).toContain('feature/MTX-9-x')
    expect(await reflogBranches(join(dir, 'nope'))).toEqual([])
  })
})
