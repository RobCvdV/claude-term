import { describe, expect, it } from 'vitest'
import { isWorkPath } from './work-projects'

describe('isWorkPath', () => {
  it('matches work checkouts and their subfolders', () => {
    expect(isWorkPath('/Users/rob/Dev/MendriX_Dev/mendrix-mobile-cordova')).toBe(true)
    expect(isWorkPath('/Users/rob/Dev/MendriX_Dev/mendrix-mobile-cordova/test')).toBe(true)
    expect(isWorkPath('/Users/rob/Dev/mendrix_dev/mmxlib')).toBe(true)
  })

  it('leaves personal projects out', () => {
    expect(isWorkPath('/Users/rob/Dev/claude-term')).toBe(false)
    expect(isWorkPath('/Users/rob/Dev/synthor')).toBe(false)
    expect(isWorkPath('')).toBe(false)
  })
})
