import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeProjectDir, sessionHomeDir } from './session-home'

let projects: string

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), 'ct-projects-'))
})
afterEach(() => rmSync(projects, { recursive: true, force: true }))

const writeTranscript = (dir: string, sid: string, lines: string[]): void => {
  mkdirSync(join(projects, dir), { recursive: true })
  writeFileSync(join(projects, dir, `${sid}.jsonl`), lines.join('\n') + '\n')
}

describe('encodeProjectDir', () => {
  it("matches Claude Code's folder encoding (/, _, . all become -)", () => {
    expect(encodeProjectDir('/Users/x/Dev/MendriX_Dev/mendrix-mobile-cordova')).toBe(
      '-Users-x-Dev-MendriX-Dev-mendrix-mobile-cordova'
    )
    expect(encodeProjectDir('/Users/x/.claude/jobs')).toBe('-Users-x--claude-jobs')
  })
})

describe('sessionHomeDir', () => {
  it('returns the dir the transcript folder encodes, not the last live shell cwd', () => {
    // a multi-repo session: shell sat in mmxlib when the app quit, but the
    // transcript lives in (= is homed in) the cordova project folder
    writeTranscript('-Users-x-Dev-MendriX-Dev-cordova', 'sess-1', [
      JSON.stringify({ type: 'user', cwd: '/Users/x/Dev/MendriX_Dev/cordova' }),
      JSON.stringify({ type: 'user', cwd: '/Users/x/Dev/MendriX_Dev/mmxlib' }),
      JSON.stringify({ type: 'user', cwd: '/Users/x/Dev/MendriX_Dev/mmxlib' })
    ])
    expect(sessionHomeDir('sess-1', projects)).toBe('/Users/x/Dev/MendriX_Dev/cordova')
  })

  it('follows a real directory move (folder name matches the new home)', () => {
    // /cd relocates the transcript: the folder now encodes the NEW dir and the
    // newest matching record wins over the pre-move ones
    writeTranscript('-Users-x-mmxlib', 'sess-5', [
      JSON.stringify({ type: 'user', cwd: '/Users/x/cordova' }),
      JSON.stringify({ type: 'user', cwd: '/Users/x/mmxlib' })
    ])
    expect(sessionHomeDir('sess-5', projects)).toBe('/Users/x/mmxlib')
  })

  it('returns null when no record cwd matches the folder', () => {
    writeTranscript('-Users-x-cordova', 'sess-6', [
      JSON.stringify({ type: 'user', cwd: '/Users/x/elsewhere' })
    ])
    expect(sessionHomeDir('sess-6', projects)).toBeNull()
  })

  it('skips trailing records without a cwd and corrupt lines', () => {
    writeTranscript('-Users-x-repo', 'sess-2', [
      JSON.stringify({ cwd: '/Users/x/repo' }),
      JSON.stringify({ type: 'summary' }),
      '{ corrupt'
    ])
    expect(sessionHomeDir('sess-2', projects)).toBe('/Users/x/repo')
  })

  it('returns null for an unknown session or unreadable store', () => {
    expect(sessionHomeDir('nope', projects)).toBeNull()
    expect(sessionHomeDir('nope', join(projects, 'missing'))).toBeNull()
  })

  it('returns null for a transcript with no cwd at all', () => {
    writeTranscript('-Users-x-empty', 'sess-3', [JSON.stringify({ type: 'summary' })])
    expect(sessionHomeDir('sess-3', projects)).toBeNull()
  })
})
