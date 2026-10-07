import { describe, expect, it } from 'vitest'
import type { TabStatus } from '../../shared/types'
import { autoTabTitle, cwdFromOsc7 } from './tab-title'

const status = (cwd: string, claudeActive: boolean): TabStatus =>
  ({ cwd, claudeActive }) as TabStatus

describe('autoTabTitle', () => {
  it("names a session tab after the session's home, wherever the shell was", () => {
    expect(autoTabTitle(status('/Users/me/Dev/app', true), '/Users/me')).toBe('app')
  })

  it("names a plain terminal after the shell's current folder", () => {
    expect(autoTabTitle(status('/Users/me', false), '/Users/me/Dev/app')).toBe('app')
  })

  it('falls back to the tab folder before the shell has reported one', () => {
    expect(autoTabTitle(status('/Users/me/Dev/app/', false))).toBe('app')
  })

  it('keeps the root readable', () => {
    expect(autoTabTitle(status('/', false))).toBe('/')
  })
})

describe('cwdFromOsc7', () => {
  it('reads the path, with or without a host', () => {
    expect(cwdFromOsc7('file://mac.local/Users/me/Dev')).toBe('/Users/me/Dev')
    expect(cwdFromOsc7('file:///Users/me')).toBe('/Users/me')
  })

  it('decodes an encoded path and tolerates a raw one', () => {
    expect(cwdFromOsc7('file://h/Users/me/My%20Dir')).toBe('/Users/me/My Dir')
    expect(cwdFromOsc7('file://h/Users/me/100%')).toBe('/Users/me/100%')
  })

  it('ignores anything else', () => {
    expect(cwdFromOsc7('http://example.com/x')).toBeNull()
  })
})
