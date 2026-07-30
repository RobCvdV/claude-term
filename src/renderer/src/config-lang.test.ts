import { describe, expect, it } from 'vitest'
import { languageForFile, PLAINTEXT } from './config-lang'

describe('languageForFile', () => {
  it('maps the common structured formats', () => {
    expect(languageForFile('package.json')).toBe('json')
    expect(languageForFile('tsconfig.jsonc')).toBe('json')
    expect(languageForFile('release.yml')).toBe('yaml')
    expect(languageForFile('docker-compose.yaml')).toBe('yaml')
    expect(languageForFile('pom.xml')).toBe('xml')
  })

  it('maps scripts that act as configuration', () => {
    expect(languageForFile('electron.vite.config.ts')).toBe('typescript')
    expect(languageForFile('eslint.config.mjs')).toBe('javascript')
    expect(languageForFile('babel.config.cjs')).toBe('javascript')
  })

  it('resolves on the last extension, not an earlier dotted segment', () => {
    // ".config.ts" must read as TypeScript, never as something matching "config"
    expect(languageForFile('vitest.config.ts')).toBe('typescript')
    expect(languageForFile('a.b.c.yml')).toBe('yaml')
  })

  it('maps Delphi project files to xml and Delphi sources to pascal', () => {
    expect(languageForFile('MyApp.dproj')).toBe('xml')
    expect(languageForFile('All.groupproj')).toBe('xml')
    expect(languageForFile('MyApp.dpr')).toBe('pascal')
    expect(languageForFile('Shared.inc')).toBe('pascal')
  })

  it('maps formats with no monaco tokenizer to the closest fit', () => {
    // no toml/properties tokenizer ships with monaco; ini is the nearest match
    expect(languageForFile('Cargo.toml')).toBe('ini')
    expect(languageForFile('gradle.properties')).toBe('ini')
    expect(languageForFile('app.cfg')).toBe('ini')
    // gradle is groovy, which monaco lacks — java is close enough to read
    expect(languageForFile('build.gradle')).toBe('java')
  })

  it('maps plists to xml', () => {
    expect(languageForFile('Info.plist')).toBe('xml')
  })

  it('maps env files, including the suffixed variants', () => {
    expect(languageForFile('.env')).toBe('ini')
    expect(languageForFile('.env.local')).toBe('ini')
    expect(languageForFile('.env.production')).toBe('ini')
  })

  it('treats a bare dotfile rc as JSON, which is the convention', () => {
    expect(languageForFile('.prettierrc')).toBe('json')
    expect(languageForFile('.babelrc')).toBe('json')
    // an explicit extension still wins over the bare-rc rule
    expect(languageForFile('.eslintrc.yml')).toBe('yaml')
    expect(languageForFile('.eslintrc.json')).toBe('json')
    // ...and the named exceptions win over it too: these hold a bare value, not
    // JSON, even though they end in "rc"
    expect(languageForFile('.nvmrc')).toBe(PLAINTEXT)
    expect(languageForFile('.npmrc')).toBe('ini')
  })

  it('maps extensionless JSON files that only their name identifies', () => {
    expect(languageForFile('.watchmanconfig')).toBe('json')
  })

  it('maps ruby-style build files by name', () => {
    expect(languageForFile('Podfile')).toBe('ruby')
    expect(languageForFile('Gemfile')).toBe('ruby')
    expect(languageForFile('Dockerfile')).toBe('dockerfile')
  })

  it('is case-insensitive on names and extensions', () => {
    expect(languageForFile('DOCKERFILE')).toBe('dockerfile')
    expect(languageForFile('Config.YML')).toBe('yaml')
  })

  it('accepts a path and decides on its final segment', () => {
    expect(languageForFile('.claude/settings.json')).toBe('json')
    expect(languageForFile('.github/workflows/release.yml')).toBe('yaml')
    expect(languageForFile('.claude/agents/reviewer.md')).toBe('markdown')
  })

  it('falls back to plaintext rather than guess a misleading tokenizer', () => {
    // .gitignore patterns and Makefile recipes would both be coloured wrongly
    expect(languageForFile('.gitignore')).toBe(PLAINTEXT)
    expect(languageForFile('Makefile')).toBe(PLAINTEXT)
    expect(languageForFile('.nvmrc')).toBe(PLAINTEXT)
    expect(languageForFile('LICENSE')).toBe(PLAINTEXT)
    expect(languageForFile('mystery.zzz')).toBe(PLAINTEXT)
  })
})
