import { describe, expect, it, vi } from 'vitest'
import { completeModCommand, runModCommand, type ModCommandDeps } from './mod-commands'

function deps(over: Partial<ModCommandDeps> = {}): ModCommandDeps {
  return {
    cwd: () => '/p',
    type: vi.fn(),
    submit: vi.fn(),
    setColor: vi.fn(),
    tickets: vi.fn(async () => [
      { key: 'MTX-12', summary: 'Fix the login', status: 'Active' },
      { key: 'MTX-345', summary: 'Crash on start', status: 'To Do' }
    ]),
    pickup: vi.fn(async () => ({
      ok: true as const,
      branch: 'bugfix/MTX-12-fix-the-login',
      created: true,
      prompt: 'Look at MTX-12',
      warnings: []
    })),
    createFile: vi.fn(async () => ({ ok: true as const, path: '/p/docs/a.md' })),
    openInEditor: vi.fn(),
    switchBranch: vi.fn(async () => ({ ok: true, branch: 'feature/x' })),
    removeDir: vi.fn(() => ({ ok: true as const, dir: '/lib' })),
    npmScripts: vi.fn(async () => [{ dir: '', name: 'test', command: 'vitest' }]),
    branches: vi.fn(async () => [{ key: 'main' }, { key: 'lib:dev', root: '/lib', repo: 'lib' }]),
    dirs: vi.fn(async () => ['src/', 'docs/']),
    extraDirs: () => [{ name: 'mmxlib', path: '/dev/mmxlib' }],
    askClaudia: vi.fn(() => 1),
    summonClaudia: vi.fn(async (away: boolean) => (away ? 'gone' : 'coming')),
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

  it('/pickup starts the ticket and hands the session its prompt', async () => {
    const d = deps()
    const r = await runModCommand(d, 't', 'pickup', 'mtx-12')
    expect(d.pickup).toHaveBeenCalledWith('t', 'MTX-12')
    expect(d.submit).toHaveBeenCalledWith('t', 'Look at MTX-12')
    expect(r.text).toBe('Created bugfix/MTX-12-fix-the-login')
    expect((await runModCommand(d, 't', 'pickup', 'login')).text).toMatch(/^Usage/)
  })

  it('/claudia-* asks Claudia, or says she is not there', async () => {
    const d = deps()
    expect(await runModCommand(d, 't', 'claudia-waiting', '')).toEqual({ text: 'Asked Claudia.' })
    expect(d.askClaudia).toHaveBeenCalledWith('t', 'waiting')
    const none = deps({ askClaudia: () => 0 })
    expect((await runModCommand(none, 't', 'claudia-status', '')).text).toBe(
      "Claudia isn't connected."
    )
  })

  it('/summon-claudia starts her, or sends her away', async () => {
    const d = deps()
    expect((await runModCommand(d, 't', 'summon-claudia', '')).text).toBe('coming')
    expect((await runModCommand(d, 't', 'summon-claudia', 'away')).text).toBe('gone')
    expect(d.summonClaudia).toHaveBeenCalledWith(true)
    expect((await runModCommand(d, 't', 'summon-claudia', 'now')).text).toMatch(/^Usage/)
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
    expect(await completeModCommand(d, 't', 'pickup', 'mtx-3')).toEqual([
      { text: 'MTX-345', description: 'Crash on start · To Do' }
    ])
    expect((await completeModCommand(d, 't', 'pickup', 'login')).map((s) => s.text)).toEqual([
      'MTX-12'
    ])
    expect((await completeModCommand(d, 't', 'color', 'o')).map((s) => s.text)).toEqual([
      'orange',
      'off'
    ])
  })
})
