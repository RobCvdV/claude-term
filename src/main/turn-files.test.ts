import { describe, expect, it } from 'vitest'
import { turnFiles, turnSteps } from './turn-files'

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

describe('turnSteps', () => {
  const wrote = (path: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path } }] }
    })
  const said = (text: string, ts: string): string =>
    JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text }] } })

  const tail = [
    said('first', '2026-08-18T10:00:00Z'),
    wrote('/p/a.ts'),
    said('second', '2026-08-18T10:10:00Z'),
    wrote('/p/b.ts'),
    said('third', '2026-08-18T10:20:00Z'),
    wrote('/p/c.ts'),
    wrote('/p/b.ts')
  ].join('\n')

  it('walks back one turn per step, accumulating the files', () => {
    const steps = turnSteps(tail)
    expect(steps.map((s) => s.files)).toEqual([
      ['/p/c.ts', '/p/b.ts'],
      ['/p/b.ts', '/p/c.ts'],
      ['/p/a.ts', '/p/b.ts', '/p/c.ts']
    ])
    expect(steps.map((s) => s.startedAt)).toEqual([
      '2026-08-18T10:20:00Z',
      '2026-08-18T10:10:00Z',
      '2026-08-18T10:00:00Z'
    ])
  })

  it('stops at the cap', () => {
    expect(turnSteps(tail, 2)).toHaveLength(2)
  })

  it('agrees with turnFiles about the newest turn', () => {
    expect(turnSteps(tail)[0]).toEqual(turnFiles(tail))
  })

  it('treats everything in view as one turn when no user message is left', () => {
    const steps = turnSteps([wrote('/p/a.ts'), wrote('/p/b.ts')].join('\n'))
    expect(steps).toEqual([{ files: ['/p/a.ts', '/p/b.ts'], startedAt: null }])
  })
})
