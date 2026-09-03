import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addAllowRule, CLAUDE_SETTINGS_FILE, hasShellOperator, suggestRule } from './allow-rule'

const dirs: string[] = []
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-allow-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const bash = (command: string): string | null => suggestRule('Bash', { command })
const settingsOf = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, CLAUDE_SETTINGS_FILE), 'utf8'))

describe('hasShellOperator', () => {
  it('spots the syntax that makes a command more than it looks', () => {
    for (const c of [
      'mkdir a && rm -rf b',
      'ls; whoami',
      'cat x | sh',
      'echo $(whoami)',
      'echo `id`',
      'curl x > /etc/hosts',
      'sleep 1 &'
    ]) {
      expect(hasShellOperator(c), c).toBe(true)
    }
  })

  it('is not fooled by operators inside quotes', () => {
    expect(hasShellOperator('echo "a && b"')).toBe(false)
    expect(hasShellOperator("git commit -m 'fix; really'")).toBe(false)
    expect(hasShellOperator('echo \\&\\&')).toBe(false)
  })

  it('passes an ordinary command', () => {
    expect(hasShellOperator('mkdir -p out/dir')).toBe(false)
  })
})

describe('suggestRule', () => {
  it('derives a prefix rule for a simple command', () => {
    expect(bash('mkdir out')).toBe('Bash(mkdir *)')
    expect(bash('rm -rf build')).toBe('Bash(rm *)')
  })

  it('keeps the subcommand for tools where the first word says too little', () => {
    // `git *` would also cover `git push --force`
    expect(bash('git status --short')).toBe('Bash(git status *)')
    expect(bash('npm run build')).toBe('Bash(npm run *)')
    expect(bash('docker compose up -d')).toBe('Bash(docker compose *)')
  })

  it('makes an exact rule when there is nothing to widen', () => {
    expect(bash('whoami')).toBe('Bash(whoami)')
    expect(bash('git status')).toBe('Bash(git status)')
  })

  it('offers nothing for a compound command', () => {
    // a prefix rule here would license the second half too
    expect(bash('mkdir a && rm -rf /')).toBeNull()
    expect(bash('ls | sh')).toBeNull()
  })

  it('offers nothing when a subcommand tool has no subcommand', () => {
    expect(bash('git')).toBeNull()
    expect(bash('npm --version')).toBeNull()
  })

  it('offers nothing for a tool whose rule would be a guessed path', () => {
    expect(suggestRule('Write', { file_path: '/a/b.ts' })).toBeNull()
    expect(suggestRule('Edit', { file_path: '/a/b.ts' })).toBeNull()
    expect(suggestRule('WebFetch', { url: 'https://x' })).toBeNull()
  })

  it('offers nothing for nonsense', () => {
    expect(bash('')).toBeNull()
    expect(bash('   ')).toBeNull()
    expect(bash('--flag only')).toBeNull()
    expect(suggestRule('Bash', {})).toBeNull()
  })
})

describe('addAllowRule', () => {
  it('creates the file Claude Code reads, with the rule in it', () => {
    const dir = project()
    expect(addAllowRule(dir, 'Bash(mkdir *)')).toBe(true)
    expect(settingsOf(dir)).toEqual({ permissions: { allow: ['Bash(mkdir *)'] } })
  })

  it('appends without disturbing what is already allowed', () => {
    const dir = project()
    mkdirSync(join(dir, '.claude'))
    writeFileSync(
      join(dir, CLAUDE_SETTINGS_FILE),
      JSON.stringify({ permissions: { allow: ['Bash(ls *)'], deny: ['Read(**/*.pem)'] } })
    )
    expect(addAllowRule(dir, 'Bash(mkdir *)')).toBe(true)
    const out = settingsOf(dir) as { permissions: { allow: string[]; deny: string[] } }
    expect(out.permissions.allow).toEqual(['Bash(ls *)', 'Bash(mkdir *)'])
    expect(out.permissions.deny).toEqual(['Read(**/*.pem)'])
  })

  it('keeps keys it knows nothing about', () => {
    const dir = project()
    mkdirSync(join(dir, '.claude'))
    writeFileSync(
      join(dir, CLAUDE_SETTINGS_FILE),
      JSON.stringify({ env: { FOO: '1' }, hooks: { Stop: [] } })
    )
    addAllowRule(dir, 'Bash(mkdir *)')
    const out = settingsOf(dir)
    expect(out.env).toEqual({ FOO: '1' })
    expect(out.hooks).toEqual({ Stop: [] })
  })

  it('does not add the same rule twice', () => {
    const dir = project()
    expect(addAllowRule(dir, 'Bash(mkdir *)')).toBe(true)
    expect(addAllowRule(dir, 'Bash(mkdir *)')).toBe(false)
    const out = settingsOf(dir) as { permissions: { allow: string[] } }
    expect(out.permissions.allow).toEqual(['Bash(mkdir *)'])
  })

  it('refuses to overwrite a file it cannot parse', () => {
    const dir = project()
    mkdirSync(join(dir, '.claude'))
    const path = join(dir, CLAUDE_SETTINGS_FILE)
    // these files get hand-edited, sometimes with comments
    writeFileSync(path, '{ // mine\n "permissions": {} }')
    expect(addAllowRule(dir, 'Bash(mkdir *)')).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('// mine')
  })

  it('survives a settings file that is not an object', () => {
    const dir = project()
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, CLAUDE_SETTINGS_FILE), '[1,2,3]')
    expect(addAllowRule(dir, 'Bash(mkdir *)')).toBe(false)
  })
})
