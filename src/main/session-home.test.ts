import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionHomeDir } from './session-home'

let projects: string

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), 'ct-projects-'))
})
afterEach(() => rmSync(projects, { recursive: true, force: true }))

const writeTranscript = (dir: string, sid: string, lines: string[]): void => {
  mkdirSync(join(projects, dir), { recursive: true })
  writeFileSync(join(projects, dir, `${sid}.jsonl`), lines.join('\n') + '\n')
}

describe('sessionHomeDir', () => {
  it('returns the cwd of the last transcript record', () => {
    writeTranscript('-Users-x-cordova', 'sess-1', [
      JSON.stringify({ type: 'user', cwd: '/Users/x/mmxlib' }),
      JSON.stringify({ type: 'user', cwd: '/Users/x/cordova' })
    ])
    expect(sessionHomeDir('sess-1', projects)).toBe('/Users/x/cordova')
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
