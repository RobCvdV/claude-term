import { describe, expect, it } from 'vitest'
import { turnFiles } from './turn-files'

const line = (o: unknown): string => JSON.stringify(o)

const userSaid = (text: string, timestamp?: string): string =>
  line({ type: 'user', timestamp, message: { content: [{ type: 'text', text }] } })

const toolResult = (): string =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })

const edited = (name: string, file: string, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: { file_path: file, ...extra } }] }
  })

describe('turnFiles', () => {
  it('collects the files written since the user last spoke', () => {
    const t = [
      userSaid('first'),
      edited('Edit', '/p/old.ts'),
      userSaid('now change these', '2026-08-17T10:00:00Z'),
      edited('Edit', '/p/a.ts'),
      toolResult(),
      edited('Write', '/p/b.ts'),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
    ].join('\n')
    expect(turnFiles(t)).toEqual({
      files: ['/p/a.ts', '/p/b.ts'],
      startedAt: '2026-08-17T10:00:00Z'
    })
  })

  it('does not treat a tool result or hook output as the start of a turn', () => {
    const t = [
      userSaid('go'),
      edited('Edit', '/p/a.ts'),
      toolResult(),
      line({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'hook' }] } }),
      edited('Edit', '/p/b.ts')
    ].join('\n')
    expect(turnFiles(t).files).toEqual(['/p/a.ts', '/p/b.ts'])
  })

  it('counts a subagent’s edits as part of the turn', () => {
    const sidechain = line({
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/p/sub.ts' } }] }
    })
    expect(turnFiles([userSaid('go'), sidechain].join('\n')).files).toEqual(['/p/sub.ts'])
  })

  it('ignores tools that only read', () => {
    const t = [
      userSaid('go'),
      edited('Read', '/p/a.ts'),
      edited('Grep', '/p/b.ts'),
      edited('Bash', '/p/c.ts'),
      edited('Edit', '/p/d.ts')
    ].join('\n')
    expect(turnFiles(t).files).toEqual(['/p/d.ts'])
  })

  it('takes a notebook path, and dedupes repeat edits', () => {
    const t = [
      userSaid('go'),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/p/n.ipynb' } }
          ]
        }
      }),
      edited('Edit', '/p/a.ts'),
      edited('Edit', '/p/a.ts')
    ].join('\n')
    expect(turnFiles(t).files).toEqual(['/p/n.ipynb', '/p/a.ts'])
  })

  it('walks past a half-written last line', () => {
    const t = [userSaid('go'), edited('Edit', '/p/a.ts'), '{"type":"assist'].join('\n')
    expect(turnFiles(t).files).toEqual(['/p/a.ts'])
  })

  it('has no files and no start for an empty transcript', () => {
    expect(turnFiles('')).toEqual({ files: [], startedAt: null })
  })

  it('falls back to the whole transcript when the user never spoke', () => {
    const t = [toolResult(), edited('Edit', '/p/a.ts')].join('\n')
    expect(turnFiles(t).files).toEqual(['/p/a.ts'])
  })
})
