import { describe, expect, it } from 'vitest'
import { iconFor } from './file-icons'

const text = (name: string): string | undefined => iconFor(name)?.text

describe('iconFor', () => {
  it('badges source files by extension, ignoring case', () => {
    expect(text('App.tsx')).toBe('TSX')
    expect(text('index.TS')).toBe('TS')
    expect(text('Unit1.pas')).toBe('PAS')
    expect(text('package.json')).toBe('{}')
    expect(text('README.md')).toBe('MD')
  })

  it('prefers the longest extension', () => {
    expect(text('env.d.ts')).toBe('DTS')
  })

  it('treats configuration as configuration, whatever its language', () => {
    for (const name of ['vite.config.ts', '.eslintrc.json', '.env.local', '.gitignore', 'ci.yml']) {
      expect(iconFor(name), name).toBeDefined()
      expect(text(name), name).toBeUndefined()
    }
  })

  it('leaves unknown files plain', () => {
    expect(iconFor('notes')).toBeUndefined()
    expect(iconFor('photo.png')).toBeUndefined()
  })
})
