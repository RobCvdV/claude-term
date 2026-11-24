import { describe, expect, it, vi } from 'vitest'
import { completeModCommand, runModCommand, type ModCommandDeps } from './mod-commands'

function deps(over: Partial<ModCommandDeps> = {}): ModCommandDeps {
  return {
    cwd: () => '/p',
    type: vi.fn(),
    setColor: vi.fn(),
    createFile: vi.fn(async () => ({ ok: true as const, path: '/p/docs/a.md' })),
    openInEditor: vi.fn(),
    switchBranch: vi.fn(async () => ({ ok: true, branch: 'feature/x' })),
    removeDir: vi.fn(() => ({ ok: true as const, dir: '/lib' })),
    npmScripts: vi.fn(async () => [{ dir: '', name: 'test', command: 'vitest' }]),
    branches: vi.fn(async () => [{ key: 'main' }, { key: 'lib:dev', root: '/lib', repo: 'lib' }]),
    dirs: vi.fn(async () => ['src/', 'docs/']),
    extraDirs: () => [{ name: 'mmxlib', path: '/dev/mmxlib' }],
    ...over
  }
}

describe('runModCommand', () => {
  it('/color tints the tab', async () => {
    const d = deps()
    expect(await runModCommand(d, 't', 'color', ' Orange ')).toEqual({ text: 'Tab color: orange' })
    expect(d.setColor).toHaveBeenCalledWith('t', 'orange')
  })

  it('/add-file creates and opens the file, or says why not', async () => {
    const d = deps()
    expect((await runModCommand(d, 't', 'add-file', 'docs/a.md')).text).toBe('Created docs/a.md')
    expect(d.openInEditor).toHaveBeenCalledWith('t', '/p/docs/a.md')
    const failing = deps({ createFile: async () => ({ ok: false, error: 'exists' }) })
    expect((await runModCommand(failing, 't', 'add-file', 'a.md')).text).toBe('exists')
    expect(
      (await runModCommand(deps({ createFile: async () => null }), 't', 'add-file', 'a')).text
    ).toBe('Not created.')
  })

  it('/switch tells the model its files may have changed', async () => {
    const r = await runModCommand(deps(), 't', 'switch', 'feature/x')
    expect(r.text).toBe('Switched to feature/x')
    expect(r.context).toContain('re-read before editing')
  })

  it('/npm types the run line, params kept, to finish and send', async () => {
    const d = deps()
    await runModCommand(d, 't', 'npm', 'test --watch')
    expect(d.type).toHaveBeenCalledWith('t', '!npm run test --watch ')
  })

  it('asks for the argument when it is missing', async () => {
    expect((await runModCommand(deps(), 't', 'switch', '  ')).text).toMatch(/^Usage/)
  })
})

describe('completeModCommand', () => {
  it('completes branches, scripts, folders and colors', async () => {
    const d = deps()
    expect((await completeModCommand(d, 't', 'switch', 'ma')).map((s) => s.text)).toEqual([
      'main',
      'lib:dev'
    ])
    expect((await completeModCommand(d, 't', 'npm', 't'))[0]).toMatchObject({
      text: 'test',
      description: 'vitest'
    })
    expect((await completeModCommand(d, 't', 'add-file', 'mm')).map((s) => s.text)).toEqual([
      'src/',
      'docs/',
      '/dev/mmxlib/'
    ])
    expect((await completeModCommand(d, 't', 'color', 'o')).map((s) => s.text)).toEqual([
      'orange',
      'off'
    ])
  })
})
