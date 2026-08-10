import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { listNpmScripts } from './npm-scripts'

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'npm-scripts-'))
  const pkg = (scripts: Record<string, string>): string => JSON.stringify({ scripts })
  writeFileSync(join(root, 'package.json'), pkg({ dev: 'vite dev', build: 'vite build' }))
  mkdirSync(join(root, 'app'))
  writeFileSync(join(root, 'app', 'package.json'), pkg({ start: 'node index.js' }))
  mkdirSync(join(root, 'docs')) // no package.json
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'dep', 'package.json'), pkg({ evil: 'x' }))
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, '.hidden', 'package.json'), pkg({ shy: 'x' }))
  mkdirSync(join(root, 'broken'))
  writeFileSync(join(root, 'broken', 'package.json'), '{not json')
  return root
}

describe('listNpmScripts', () => {
  it('lists root scripts first, then one-level subfolder scripts', () => {
    const scripts = listNpmScripts(makeProject(), '')
    expect(scripts).toEqual([
      { dir: '', name: 'dev', command: 'vite dev' },
      { dir: '', name: 'build', command: 'vite build' },
      { dir: 'app', name: 'start', command: 'node index.js' }
    ])
  })

  it('skips node_modules, hidden folders, and unparsable package.json', () => {
    const keys = listNpmScripts(makeProject(), '').map((s) => `${s.dir}/${s.name}`)
    expect(keys).not.toContain('node_modules/evil')
    expect(keys.some((k) => k.includes('hidden') || k.includes('broken'))).toBe(false)
  })

  it('filters by substring and subsequence on dir/name', () => {
    const root = makeProject()
    expect(listNpmScripts(root, 'start').map((s) => s.name)).toEqual(['start'])
    expect(listNpmScripts(root, 'app/st').map((s) => s.name)).toEqual(['start'])
    // subsequence: "bld" → build
    expect(listNpmScripts(root, 'bld').map((s) => s.name)).toEqual(['build'])
    expect(listNpmScripts(root, 'nomatch-xyz')).toEqual([])
  })

  it('returns nothing for a folder without any package.json', () => {
    const empty = mkdtempSync(join(tmpdir(), 'npm-scripts-empty-'))
    expect(listNpmScripts(empty, '')).toEqual([])
  })
})
