import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readProjectSettings, SETTINGS_FILE, writeProjectSettings } from './project-settings'

let dir: string
const file = (): string => join(dir, SETTINGS_FILE)
const put = (text: string): void => {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(file(), text)
}
const onDisk = (): unknown => JSON.parse(readFileSync(file(), 'utf8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'projset-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readProjectSettings', () => {
  it('is empty for a project that has no file', () => {
    expect(readProjectSettings(dir)).toEqual({})
  })

  it('reads the tab colour', () => {
    put('{ "tabColor": "#d97757" }')
    expect(readProjectSettings(dir)).toEqual({ tabColor: '#d97757' })
  })

  it('ignores a value of the wrong shape rather than passing it on', () => {
    put('{ "tabColor": 42 }')
    expect(readProjectSettings(dir)).toEqual({})
    put('{ "tabColor": "" }')
    expect(readProjectSettings(dir)).toEqual({})
  })

  it('is empty for a file that is broken, an array, or not an object', () => {
    put('{ "tabColor": ')
    expect(readProjectSettings(dir)).toEqual({})
    put('["blue"]')
    expect(readProjectSettings(dir)).toEqual({})
    put('"blue"')
    expect(readProjectSettings(dir)).toEqual({})
  })
})

describe('writeProjectSettings', () => {
  it('creates the file, and .claude with it', () => {
    expect(writeProjectSettings(dir, { tabColor: 'blue' })).toBe(true)
    expect(onDisk()).toEqual({ tabColor: 'blue' })
    expect(readProjectSettings(dir)).toEqual({ tabColor: 'blue' })
  })

  it('keeps keys it does not know about', () => {
    put('{ "somethingElse": { "deep": true }, "tabColor": "blue" }')
    writeProjectSettings(dir, { tabColor: 'green' })
    expect(onDisk()).toEqual({ somethingElse: { deep: true }, tabColor: 'green' })
  })

  it('removes a key when the patch says null', () => {
    put('{ "tabColor": "blue", "keepMe": 1 }')
    writeProjectSettings(dir, { tabColor: null })
    expect(onDisk()).toEqual({ keepMe: 1 })
    expect(readProjectSettings(dir)).toEqual({})
  })

  it('refuses to overwrite a file it cannot parse', () => {
    put('{ this was hand-edited and is broken')
    expect(writeProjectSettings(dir, { tabColor: 'blue' })).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{ this was hand-edited and is broken')
  })

  it('writes json a person can read, ending in a newline', () => {
    writeProjectSettings(dir, { tabColor: 'blue' })
    expect(readFileSync(file(), 'utf8')).toBe('{\n  "tabColor": "blue"\n}\n')
  })

  it('reports failure when the project folder is gone', () => {
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'a file where the folder should be')
    expect(writeProjectSettings(dir, { tabColor: 'blue' })).toBe(false)
  })
})
