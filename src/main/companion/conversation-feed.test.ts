import { describe, expect, it } from 'vitest'
import { CONVERSATION_WINDOW, MAX_TURN_CHARS } from '../../shared/companion'
import type { ConvoTurn } from '../transcript-search'
import { ConversationFeed, toTurn, windowOf } from './conversation-feed'

const turn = (text: string, role: ConvoTurn['role'] = 'claude'): ConvoTurn => ({
  role,
  time: '2026-08-20T10:00:00Z',
  text
})

/** A transcript that grows in place, like the real parse cache does. */
function transcript(...initial: ConvoTurn[]): {
  turns: ConvoTurn[]
  append: (...t: ConvoTurn[]) => void
} {
  const turns = [...initial]
  return { turns, append: (...t) => turns.push(...t) }
}

function feed(
  sessions: Record<string, ConvoTurn[] | null>,
  tabs: Record<string, string | null>
): ConversationFeed {
  return new ConversationFeed({
    turnsFor: (sessionId) => sessions[sessionId] ?? null,
    sessionOf: (tabId) => tabs[tabId] ?? null
  })
}

describe('toTurn', () => {
  it('keeps the tool name only when there is one', () => {
    expect(toTurn(turn('hi'))).toEqual({ role: 'claude', time: '2026-08-20T10:00:00Z', text: 'hi' })
    expect(toTurn({ ...turn('ls', 'tool'), tool: 'Bash' }).tool).toBe('Bash')
  })

  it('cuts a turn nobody wants to read on a phone', () => {
    const long = toTurn(turn('x'.repeat(MAX_TURN_CHARS + 500)))
    expect(long.text).toHaveLength(MAX_TURN_CHARS + 1)
    expect(long.text.endsWith('…')).toBe(true)
  })
})

describe('windowOf', () => {
  it('hands over the tail and says how much came before', () => {
    const turns = Array.from({ length: CONVERSATION_WINDOW + 15 }, (_, i) => turn(`t${i}`))
    const win = windowOf(turns)
    expect(win.turns).toHaveLength(CONVERSATION_WINDOW)
    expect(win.before).toBe(15)
    expect(win.cursor).toBe(turns.length)
    expect(win.turns[0].text).toBe('t15')
  })

  it('reports nothing before a short conversation', () => {
    expect(windowOf([turn('only')]).before).toBe(0)
  })
})

describe('ConversationFeed', () => {
  it('hands a subscriber the recent history', () => {
    const t = transcript(turn('one'), turn('two'))
    const f = feed({ s1: t.turns }, { t1: 's1' })
    const win = f.subscribe('d1', 't1')
    expect(win?.turns.map((x) => x.text)).toEqual(['one', 'two'])
    expect(f.active()).toBe(1)
  })

  it('sends only what is new on the next poll', () => {
    const t = transcript(turn('one'))
    const f = feed({ s1: t.turns }, { t1: 's1' })
    f.subscribe('d1', 't1')
    expect(f.poll()).toEqual([])

    t.append(turn('two'), turn('three'))
    const [delta] = f.poll()
    expect(delta.turns.map((x) => x.text)).toEqual(['two', 'three'])
    expect(delta.reset).toBe(false)
    // and nothing again until more arrives
    expect(f.poll()).toEqual([])
  })

  it('costs nothing while a session is idle', () => {
    const t = transcript(turn('one'))
    const f = feed({ s1: t.turns }, { t1: 's1' })
    f.subscribe('d1', 't1')
    for (let i = 0; i < 5; i++) expect(f.poll()).toEqual([])
  })

  it('waits patiently for a tab whose session has not written a transcript', () => {
    const sessions: Record<string, ConvoTurn[] | null> = { s1: null }
    const f = new ConversationFeed({
      turnsFor: (id) => sessions[id] ?? null,
      sessionOf: () => 's1'
    })
    expect(f.subscribe('d1', 't1')).toBeNull()
    expect(f.poll()).toEqual([])

    sessions.s1 = [turn('first words')]
    const [delta] = f.poll()
    expect(delta.turns.map((x) => x.text)).toEqual(['first words'])
    expect(delta.reset).toBe(true)
  })

  it('starts over when the tab moves to a different session', () => {
    const tabs: Record<string, string | null> = { t1: 's1' }
    const f = new ConversationFeed({
      turnsFor: (id) => (id === 's1' ? [turn('old')] : [turn('new one'), turn('new two')]),
      sessionOf: (tabId) => tabs[tabId] ?? null
    })
    f.subscribe('d1', 't1')
    tabs.t1 = 's2'
    const [delta] = f.poll()
    expect(delta.reset).toBe(true)
    expect(delta.turns.map((x) => x.text)).toEqual(['new one', 'new two'])
  })

  it('starts over when a transcript is rewritten shorter', () => {
    const sessions: Record<string, ConvoTurn[]> = { s1: [turn('a'), turn('b'), turn('c')] }
    const f = new ConversationFeed({
      turnsFor: (id) => sessions[id],
      sessionOf: () => 's1'
    })
    f.subscribe('d1', 't1')
    sessions.s1 = [turn('fresh')]
    const [delta] = f.poll()
    expect(delta.reset).toBe(true)
    expect(delta.turns.map((x) => x.text)).toEqual(['fresh'])
  })

  it('gives each device its own cursor', () => {
    const t = transcript(turn('one'))
    const f = feed({ s1: t.turns }, { t1: 's1' })
    f.subscribe('d1', 't1')
    t.append(turn('two'))
    f.subscribe('d2', 't1') // joins later, so starts from the current state

    const deltas = f.poll()
    expect(deltas.map((d) => d.deviceId)).toEqual(['d1'])
    expect(deltas[0].turns.map((x) => x.text)).toEqual(['two'])
  })

  it('follows one session at a time per device', () => {
    const f = feed({ s1: [turn('a')], s2: [turn('b')] }, { t1: 's1', t2: 's2' })
    f.subscribe('d1', 't1')
    f.subscribe('d1', 't2')
    expect(f.active()).toBe(1)
    expect(f.subscriptionOf('d1')?.tabId).toBe('t2')
  })

  it('forgets a device that unsubscribes', () => {
    const t = transcript(turn('one'))
    const f = feed({ s1: t.turns }, { t1: 's1' })
    f.subscribe('d1', 't1')
    f.unsubscribe('d1')
    t.append(turn('two'))
    expect(f.poll()).toEqual([])
    expect(f.active()).toBe(0)
  })

  it('drops a subscription whose tab has gone away', () => {
    const f = feed({ s1: [turn('a')] }, { t1: 's1' })
    f.subscribe('d1', 't1')
    const gone = feed({ s1: [turn('a')] }, {})
    // a tab with no session yields nothing rather than throwing
    gone.subscribe('d1', 'missing')
    expect(gone.poll()).toEqual([])
  })
})
