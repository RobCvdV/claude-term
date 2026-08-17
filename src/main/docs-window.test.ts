import { describe, expect, it, vi } from 'vitest'

// docs-window pulls in the real file-window (and so electron) at import time;
// none of it is needed to check the URL the window is opened with.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { on: () => {} },
  shell: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.stubGlobal('__dirname', '/app/out/main')

const { docsQuery } = await import('./docs-window')

const params = (query: string): URLSearchParams => new URLSearchParams(query)

describe('docsQuery', () => {
  it('names the tab, the group and the owner title', () => {
    const p = params(docsQuery('tab-1', 'my project', { group: 'docs' }))
    expect(p.get('docs')).toBe('1')
    expect(p.get('tabId')).toBe('tab-1')
    expect(p.get('group')).toBe('docs')
    expect(p.get('title')).toBe('my project')
    expect(p.get('path')).toBeNull()
  })

  it('carries the whole target, line and column included', () => {
    const p = params(
      docsQuery('tab-1', 'p', {
        group: 'docs',
        target: { path: '/p/src/a.ts', edit: true, line: 403, column: 7 }
      })
    )
    expect(p.get('path')).toBe('/p/src/a.ts')
    expect(p.get('edit')).toBe('1')
    expect(p.get('line')).toBe('403')
    expect(p.get('column')).toBe('7')
  })

  it('leaves out what the target does not say', () => {
    const p = params(docsQuery('tab-1', 'p', { group: 'docs', target: { path: '/p/a.md' } }))
    expect(p.get('edit')).toBeNull()
    expect(p.get('line')).toBeNull()
    expect(p.get('column')).toBeNull()
  })

  it('escapes a path and a title that need it', () => {
    const p = params(
      docsQuery('tab-1', 'proj & co', { group: 'docs', target: { path: '/p/with space&.ts' } })
    )
    expect(p.get('path')).toBe('/p/with space&.ts')
    expect(p.get('title')).toBe('proj & co')
  })
})
