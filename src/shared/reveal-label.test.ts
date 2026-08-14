import { describe, expect, it } from 'vitest'
import { revealLabel } from './reveal-label'

describe('revealLabel', () => {
  it('names the file manager the platform actually has', () => {
    expect(revealLabel('darwin')).toBe('Show in Finder')
    expect(revealLabel('win32')).toBe('Show in Explorer')
  })

  it('stays generic where the file manager has no one name', () => {
    expect(revealLabel('linux')).toBe('Show in files')
    expect(revealLabel('')).toBe('Show in files')
  })
})
