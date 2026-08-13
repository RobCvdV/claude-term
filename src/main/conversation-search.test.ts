import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchConversation } from './conversation-search'

let projects: string
let session = 0

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), 'ct-convo-'))
  mkdirSync(join(projects, '-Users-x-repo'), { recursive: true })
})
afterEach(() => rmSync(projects, { recursive: true, force: true }))

/** A fresh session id per test: the module caches parsed transcripts by path. */
const newSession = (): string => `sess-${++session}`

const path = (sid: string): string => join(projects, '-Users-x-repo', `${sid}.jsonl`)

const said = (who: 'user' | 'assistant', text: string): string =>
  JSON.stringify({
    type: who,
    timestamp: '2026-08-13T09:00:00.000Z',
    message: { role: who, content: text }
  }) + '\n'

describe('searchConversation', () => {
  it('finds a turn in the session transcript', () => {
    const sid = newSession()
    writeFileSync(path(sid), said('user', 'where did we land on window titles?'))
    const result = searchConversation(sid, 'window titles', false, projects)
    expect(result.found).toBe(true)
    expect(result.total).toBe(1)
    expect(result.hits[0].text).toContain('window titles')
  })

  it('says a session has no transcript rather than reporting no matches', () => {
    const missing = searchConversation('never-ran', 'anything', false, projects)
    expect(missing).toEqual({ hits: [], total: 0, searched: 0, found: false })
    const noStore = searchConversation('never-ran', 'anything', false, join(projects, 'gone'))
    expect(noStore.found).toBe(false)
  })

  it('distinguishes an empty transcript from a missing one', () => {
    const sid = newSession()
    writeFileSync(path(sid), '')
    expect(searchConversation(sid, 'anything', false, projects)).toEqual({
      hits: [],
      total: 0,
      searched: 0,
      found: true
    })
  })

  it('picks up turns appended after the first search', () => {
    const sid = newSession()
    writeFileSync(path(sid), said('user', 'first question'))
    expect(searchConversation(sid, 'question', false, projects).total).toBe(1)
    appendFileSync(path(sid), said('assistant', 'answer to the second question'))
    const again = searchConversation(sid, 'question', false, projects)
    expect(again.total).toBe(2)
    // newest first, and the earlier turn is still there (not re-parsed twice)
    expect(again.hits.map((h) => h.index)).toEqual([1, 0])
  })

  it('waits for a half-written record to be finished, then reads it', () => {
    const sid = newSession()
    const whole = said('user', 'a complete record')
    writeFileSync(path(sid), whole + '{"type":"user","message":{"content":"cut off mid')
    expect(searchConversation(sid, 'record', false, projects).total).toBe(1)
    // the rest of that record lands; it must now be searchable, exactly once
    writeFileSync(path(sid), whole + said('user', 'cut off midway record'))
    const after = searchConversation(sid, 'record', false, projects)
    expect(after.total).toBe(2)
    expect(after.hits.map((h) => h.text)).toEqual(['cut off midway record', 'a complete record'])
  })

  it('re-reads from scratch when the transcript shrinks', () => {
    const sid = newSession()
    writeFileSync(path(sid), said('user', 'one') + said('user', 'two') + said('user', 'three'))
    expect(searchConversation(sid, 'e', false, projects).total).toBe(2)
    writeFileSync(path(sid), said('user', 'three'))
    const after = searchConversation(sid, 'e', false, projects)
    expect(after.total).toBe(1)
    expect(after.hits[0].index).toBe(0)
  })

  it('counts bytes, not characters, when reading the tail', () => {
    const sid = newSession()
    writeFileSync(path(sid), said('user', 'héllo — em dash and accents'))
    expect(searchConversation(sid, 'accents', false, projects).total).toBe(1)
    appendFileSync(path(sid), said('user', 'näher — more accents'))
    const after = searchConversation(sid, 'accents', false, projects)
    expect(after.total).toBe(2)
    expect(after.hits[0].text).toBe('näher — more accents')
  })
})
