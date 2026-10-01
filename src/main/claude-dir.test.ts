import { homedir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeConfigDir, parseConfigDirs } from './claude-dir'

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

describe('parseConfigDirs', () => {
  const M = '__CLAUDE_TERM_CFG__'

  it('reads one marked value per dir, skipping shell noise', () => {
    const out = `welcome banner\n${M}/h/.claude-personal\n${M}/h/.claude-work\n`
    expect(parseConfigDirs(out, 2, '/fb')).toEqual(['/h/.claude-personal', '/h/.claude-work'])
  })

  it('falls back for empty or missing values', () => {
    expect(parseConfigDirs(`${M}\n`, 2, '/fb')).toEqual(['/fb', '/fb'])
  })
})
