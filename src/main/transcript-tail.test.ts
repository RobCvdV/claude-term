import { describe, expect, it } from 'vitest'
import { lastAssistantText } from './transcript-tail'

const rec = (obj: object): string => JSON.stringify(obj)
const assistant = (content: unknown, extra: object = {}): string =>
  rec({ type: 'assistant', message: { content }, ...extra })

describe('lastAssistantText', () => {
  it('returns the newest assistant text block', () => {
    const tail = [
      assistant([{ type: 'text', text: 'older answer' }]),
      rec({ type: 'user', message: { content: 'question' } }),
      assistant([{ type: 'text', text: 'newest answer' }])
    ].join('\n')
    expect(lastAssistantText(tail)).toBe('newest answer')
  })

  it('skips thinking-only and tool-only assistant records', () => {
    const tail = [
      assistant([{ type: 'text', text: 'real text' }]),
      assistant([{ type: 'thinking', text: 'hmm' }]),
      assistant([{ type: 'tool_use', text: '' }])
    ].join('\n')
    expect(lastAssistantText(tail)).toBe('real text')
  })

  it('skips sidechain (subagent) records', () => {
    const tail = [
      assistant([{ type: 'text', text: 'main convo' }]),
      assistant([{ type: 'text', text: 'subagent noise' }], { isSidechain: true })
    ].join('\n')
    expect(lastAssistantText(tail)).toBe('main convo')
  })

  it('takes the last text block within a record', () => {
    const tail = assistant([
      { type: 'text', text: 'first block' },
      { type: 'tool_use' },
      { type: 'text', text: 'second block' }
    ])
    expect(lastAssistantText(tail)).toBe('second block')
  })

  it('handles string content and a cut-off first line', () => {
    const tail = ['{"type":"assistant","message":{"cont', assistant('plain string reply')].join(
      '\n'
    )
    expect(lastAssistantText(tail)).toBe('plain string reply')
  })

  it('returns null when no assistant text exists', () => {
    const tail = [rec({ type: 'file-history-snapshot' }), rec({ type: 'user' }), ''].join('\n')
    expect(lastAssistantText(tail)).toBeNull()
  })
})
