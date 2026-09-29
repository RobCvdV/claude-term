import { homedir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeConfigDir } from './claude-dir'

describe('claudeConfigDir', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('follows CLAUDE_CONFIG_DIR', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/Users/x/.claude-work')
    expect(claudeConfigDir()).toBe('/Users/x/.claude-work')
  })

  it('falls back to ~/.claude', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'))
  })
})
