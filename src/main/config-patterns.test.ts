import { describe, expect, it } from 'vitest'
import { expandBraces, matchesAny, matchesPattern } from './config-patterns'

describe('expandBraces', () => {
  it('expands one group into one pattern per alternative', () => {
    expect(expandBraces('*.{yml,yaml}')).toEqual(['*.yml', '*.yaml'])
  })

  it('expands nested/multiple groups combinatorially', () => {
    expect(expandBraces('.{a,b}rc.{js,ts}')).toEqual(['.arc.js', '.arc.ts', '.brc.js', '.brc.ts'])
  })

  it('leaves a pattern without braces untouched', () => {
    expect(expandBraces('*.json')).toEqual(['*.json'])
  })
})

describe('matchesPattern', () => {
  it('matches a separator-free pattern against the base name at any depth', () => {
    // this is what makes "*.json" find .claude/settings.json — the include list
    // is written in terms of file names, not paths
    expect(matchesPattern('package.json', '*.json')).toBe(true)
    expect(matchesPattern('.claude/settings.json', '*.json')).toBe(true)
    expect(matchesPattern('a/b/c/tsconfig.json', '*.json')).toBe(true)
  })

  it('matches a pattern containing a separator against the whole relative path', () => {
    expect(matchesPattern('.github/workflows/release.yml', '.github/**')).toBe(true)
    expect(matchesPattern('src/release.yml', '.github/**')).toBe(false)
  })

  it('does not let * cross a separator', () => {
    expect(matchesPattern('a/b.json', 'a/*.json')).toBe(true)
    expect(matchesPattern('a/b/c.json', 'a/*.json')).toBe(false)
  })

  it('lets ** cross separators, and makes "**/x" match a bare "x"', () => {
    expect(matchesPattern('a/b/c.json', 'a/**/*.json')).toBe(true)
    expect(matchesPattern('test/a.ts', 'test/**')).toBe(true)
    // the optional-separator rule: "**/foo" has to match a root-level "foo" too
    expect(matchesPattern('foo.json', '**/foo.json')).toBe(true)
    expect(matchesPattern('deep/foo.json', '**/foo.json')).toBe(true)
  })

  it('treats ? as exactly one non-separator character', () => {
    expect(matchesPattern('a.ts', '?.ts')).toBe(true)
    expect(matchesPattern('ab.ts', '?.ts')).toBe(false)
    expect(matchesPattern('a/b.ts', '?/?.ts')).toBe(true)
  })

  it('matches case-insensitively — config casing is convention, not a rule', () => {
    expect(matchesPattern('Config.YML', '*.yml')).toBe(true)
    expect(matchesPattern('DOCKERFILE', 'Dockerfile')).toBe(true)
  })

  it('anchors the whole subject, so a substring does not match', () => {
    expect(matchesPattern('mypackage.json.bak', 'package.json')).toBe(false)
    expect(matchesPattern('notes.json.txt', '*.json')).toBe(false)
  })

  it('treats regex metacharacters in a pattern as literals', () => {
    // ".env" must not match "aenv" via the regex dot
    expect(matchesPattern('aenv', '.env')).toBe(false)
    expect(matchesPattern('.env', '.env')).toBe(true)
    expect(matchesPattern('a+b.json', 'a+b.json')).toBe(true)
  })

  it('matches dotfile rc conventions', () => {
    expect(matchesPattern('.prettierrc', '.*rc')).toBe(true)
    expect(matchesPattern('.eslintrc.json', '.*rc.{json,js,cjs,mjs,yml,yaml,toml}')).toBe(true)
    // a bare ".*rc" must not swallow ".eslintrc.json" — the extension form does
    expect(matchesPattern('.eslintrc.json', '.*rc')).toBe(false)
  })
})

describe('matchesAny', () => {
  it('is true when any pattern matches', () => {
    expect(matchesAny('a.yml', ['*.json', '*.yml'])).toBe(true)
  })

  it('is false for an empty pattern list', () => {
    expect(matchesAny('a.yml', [])).toBe(false)
  })
})
