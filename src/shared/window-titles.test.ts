import { describe, expect, it } from 'vitest'
import { WINDOW_KIND, windowTitle } from './window-titles'

describe('windowTitle', () => {
  it('leads with the window kind, so a title match always finds it', () => {
    expect(windowTitle(WINDOW_KIND.main, 'claude-term', 'feat/one-file-window')).toBe(
      'Terminal — claude-term — feat/one-file-window'
    )
    expect(windowTitle(WINDOW_KIND.files, 'settings.json', 'claude-term')).toBe(
      'File editor — settings.json — claude-term'
    )
  })

  it('drops parts that are missing or blank rather than leaving separators', () => {
    expect(windowTitle(WINDOW_KIND.main, null, 'claude-term', undefined, '  ')).toBe(
      'Terminal — claude-term'
    )
  })

  it('is just the kind when nothing else is known yet', () => {
    expect(windowTitle(WINDOW_KIND.main)).toBe('Terminal')
    expect(windowTitle(WINDOW_KIND.files, null)).toBe('File editor')
  })

  it('trims the parts, since tab titles come from a shell', () => {
    expect(windowTitle(WINDOW_KIND.files, '  notes.md  ')).toBe('File editor — notes.md')
  })
})
