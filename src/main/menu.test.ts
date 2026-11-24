import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, Menu: {} }))
vi.mock('./app-settings', () => ({
  appSettings: () => ({}),
  onAppSettings: () => () => {},
  setAppSettings: () => {}
}))

const { panelForKey } = await import('./menu')

const key = (
  over: Partial<Parameters<typeof panelForKey>[0]> = {}
): Parameters<typeof panelForKey>[0] => ({
  type: 'keyDown',
  code: 'KeyE',
  meta: true,
  shift: false,
  control: false,
  alt: false,
  ...over
})

describe('panelForKey', () => {
  it('⌘E is Mission control, ⇧⌘E the Work board', () => {
    expect(panelForKey(key())).toBe('mission')
    expect(panelForKey(key({ shift: true }))).toBe('board')
  })

  it('ignores key-ups, other modifiers and other keys', () => {
    expect(panelForKey(key({ type: 'keyUp' }))).toBeNull()
    expect(panelForKey(key({ meta: false }))).toBeNull()
    expect(panelForKey(key({ alt: true }))).toBeNull()
    expect(panelForKey(key({ control: true }))).toBeNull()
    expect(panelForKey(key({ code: 'KeyP' }))).toBeNull()
  })
})
