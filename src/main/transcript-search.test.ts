import { describe, expect, it } from 'vitest'
import { MAX_CONVO_HIT_CHARS, MAX_CONVO_HITS } from '../shared/types'
import { parseTurns, searchTurns, type ConvoTurn } from './transcript-search'

const line = (rec: unknown): string => JSON.stringify(rec)

const userSaid = (text: string, timestamp = '2026-08-13T10:00:00.000Z'): string =>
  line({ type: 'user', timestamp, message: { role: 'user', content: text } })

const claudeSaid = (...blocks: unknown[]): string =>
  line({
    type: 'assistant',
    timestamp: '2026-08-13T10:01:00.000Z',
    message: { role: 'assistant', content: blocks }
  })

describe('parseTurns', () => {
  it('reads what was said, oldest first', () => {
    const turns = parseTurns(
      [
        userSaid('how do I run the tests?'),
        claudeSaid({ type: 'text', text: 'With npm test.' })
      ].join('\n')
    )
    expect(turns).toEqual([
      { role: 'user', time: '2026-08-13T10:00:00.000Z', text: 'how do I run the tests?' },
      { role: 'claude', time: '2026-08-13T10:01:00.000Z', text: 'With npm test.' }
    ])
  })

  it('splits one record into a turn per block, so a hit names the right one', () => {
    const turns = parseTurns(
      claudeSaid(
        { type: 'thinking', thinking: 'the user wants the test command' },
        { type: 'text', text: 'Run npm test.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
      )
    )
    expect(turns.map((t) => [t.role, t.tool, t.text])).toEqual([
      ['thinking', undefined, 'the user wants the test command'],
      ['claude', undefined, 'Run npm test.'],
      ['tool', 'Bash', 'command: npm test']
    ])
  })

  it('flattens tool results, however they are nested', () => {
    const turns = parseTurns(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: '439 tests passed' }]
            }
          ]
        }
      })
    )
    expect(turns).toEqual([{ role: 'tool', time: null, text: '439 tests passed' }])
  })

  it('buckets machine-injected text as tool output, not as something said', () => {
    // hook output, system reminders and subagent chatter all arrive as user
    // records; counting them as the user's own words would drown out real hits
    const turns = parseTurns(
      [
        line({
          type: 'user',
          isMeta: true,
          message: { role: 'user', content: 'caveat: local cmd' }
        }),
        line({ type: 'assistant', isSidechain: true, message: { content: 'subagent reporting' } })
      ].join('\n')
    )
    expect(turns.map((t) => t.role)).toEqual(['tool', 'tool'])
  })

  it('skips records that are not conversation, and empty or broken lines', () => {
    const turns = parseTurns(
      [
        line({ type: 'ai-title', aiTitle: 'searching the conversation' }),
        line({ type: 'file-history-snapshot', messageId: 'x' }),
        '',
        '{ half a record',
        userSaid('  '),
        userSaid('real')
      ].join('\n')
    )
    expect(turns.map((t) => t.text)).toEqual(['real'])
  })
})

describe('searchTurns', () => {
  const turns: ConvoTurn[] = [
    { role: 'user', time: null, text: 'why does find in terminal not work?' },
    { role: 'claude', time: null, text: 'The TUI draws on the alternate buffer.' },
    { role: 'tool', tool: 'Bash', time: null, text: 'grep -rn buffer src/' }
  ]

  it('returns matching turns newest first', () => {
    const { hits, total } = searchTurns(turns, 'buffer')
    expect(total).toBe(1)
    expect(hits.map((h) => h.index)).toEqual([1])
  })

  it('is case-insensitive and keeps offsets into the original text', () => {
    const { hits } = searchTurns(turns, 'THE ALTERNATE')
    const { start, end } = hits[0].matches[0]
    expect(hits[0].text.slice(start, end)).toBe('the alternate')
    expect(start).toBe(hits[0].text.indexOf('the alternate'))
  })

  it('searches tool output only when asked, and says how much it searched', () => {
    expect(searchTurns(turns, 'grep').hits).toEqual([])
    expect(searchTurns(turns, 'grep').searched).toBe(2)
    const withTools = searchTurns(turns, 'grep', true)
    expect(withTools.hits.map((h) => h.tool)).toEqual(['Bash'])
    expect(withTools.searched).toBe(3)
  })

  it('treats the query as text, not as a pattern', () => {
    const dotted: ConvoTurn[] = [
      { role: 'user', time: null, text: 'src/main/ipc.ts' },
      { role: 'user', time: null, text: 'srcXmainYipcZts' }
    ]
    expect(searchTurns(dotted, 'ipc.ts').hits.map((h) => h.index)).toEqual([0])
  })

  it('finds nothing for a blank query, but still reports the size', () => {
    expect(searchTurns(turns, '   ')).toEqual({ hits: [], total: 0, searched: 2 })
  })

  it('windows a long turn around its first match, and marks it clipped', () => {
    const long = 'x'.repeat(MAX_CONVO_HIT_CHARS * 2) + ' needle ' + 'y'.repeat(MAX_CONVO_HIT_CHARS)
    const { hits } = searchTurns([{ role: 'claude', time: null, text: long }], 'needle')
    const hit = hits[0]
    expect(hit.clipped).toBe(true)
    expect(hit.text.length).toBe(MAX_CONVO_HIT_CHARS)
    expect(hit.matches).toHaveLength(1)
    // the offsets address the window that came back, not the whole turn
    expect(hit.text.slice(hit.matches[0].start, hit.matches[0].end)).toBe('needle')
  })

  it('fills the window with what came before a match at the end of a long turn', () => {
    const long = 'x'.repeat(MAX_CONVO_HIT_CHARS * 2) + 'needle'
    const { hits } = searchTurns([{ role: 'claude', time: null, text: long }], 'needle')
    // a bare lead-in would hand back 246 chars where 4000 were available
    expect(hits[0].text.length).toBe(MAX_CONVO_HIT_CHARS)
    expect(hits[0].text.endsWith('needle')).toBe(true)
    const { start, end } = hits[0].matches[0]
    expect(hits[0].text.slice(start, end)).toBe('needle')
  })

  it('keeps a short turn whole', () => {
    const { hits } = searchTurns(turns, 'buffer')
    expect(hits[0].clipped).toBe(false)
    expect(hits[0].text).toBe('The TUI draws on the alternate buffer.')
  })

  it('caps the hits it hands over but counts them all', () => {
    const many: ConvoTurn[] = Array.from({ length: MAX_CONVO_HITS + 25 }, () => ({
      role: 'user' as const,
      time: null,
      text: 'needle'
    }))
    const { hits, total } = searchTurns(many, 'needle')
    expect(hits).toHaveLength(MAX_CONVO_HITS)
    expect(total).toBe(MAX_CONVO_HITS + 25)
    // newest first: the last turn in the transcript leads
    expect(hits[0].index).toBe(many.length - 1)
  })

  it('reports every match within a turn', () => {
    const { hits } = searchTurns([{ role: 'user', time: null, text: 'aXaXa' }], 'a')
    expect(hits[0].matches).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 }
    ])
  })
})
