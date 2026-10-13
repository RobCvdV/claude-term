import { describe, expect, it } from 'vitest'
import { backgroundWork, runningOf } from './running-work'

describe('backgroundWork', () => {
  it('names a task by its command, else its description', () => {
    const evt = {
      hook_event_name: 'Stop',
      background_tasks: [
        {
          type: 'shell',
          status: 'running',
          description: 'dev server',
          command: 'npm run dev\n# more'
        },
        { type: 'monitor', status: 'running', description: 'watch the agent job' },
        { type: 'shell', status: 'running', description: '' }
      ]
    }
    expect(backgroundWork(evt)).toEqual([
      { kind: 'shell', label: 'npm run dev', since: null },
      { kind: 'monitor', label: 'watch the agent job', since: null }
    ])
    expect(backgroundWork({ hook_event_name: 'Stop' })).toEqual([])
  })
})

describe('runningOf', () => {
  const shell = { command: 'npm run dev', since: 5 }
  const bg = [{ kind: 'monitor', label: 'watch', since: null }]

  it('shows the shell command in a plain terminal', () => {
    expect(runningOf(false, shell, bg)).toEqual([{ kind: 'shell', label: 'npm run dev', since: 5 }])
  })

  it('shows background tasks, not the claude command itself, while a session runs', () => {
    expect(runningOf(true, { command: 'claude', since: 1 }, bg)).toEqual(bg)
    expect(runningOf(true, null, [])).toEqual([])
  })
})
