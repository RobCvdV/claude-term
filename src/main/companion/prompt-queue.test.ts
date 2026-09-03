import { describe, expect, it, vi } from 'vitest'
import { PromptQueue, tabCanTakeInput } from './prompt-queue'

function setup(readyTabs: Set<string> = new Set(['t1'])): {
  queue: PromptQueue
  deliver: ReturnType<typeof vi.fn>
  ready: Set<string>
} {
  const deliver = vi.fn()
  const queue = new PromptQueue({ deliver, ready: (tabId) => readyTabs.has(tabId) })
  return { queue, deliver, ready: readyTabs }
}

describe('tabCanTakeInput', () => {
  it('refuses only while a dialog owns the keyboard', () => {
    expect(tabCanTakeInput('idle')).toBe(true)
    // Claude Code queues typed input mid-turn perfectly well
    expect(tabCanTakeInput('busy')).toBe(true)
    expect(tabCanTakeInput('needs-attention')).toBe(false)
    expect(tabCanTakeInput(undefined)).toBe(false)
  })
})

describe('PromptQueue', () => {
  it('delivers straight away when the tab can take it', () => {
    const { queue, deliver } = setup()
    expect(queue.submit('t1', 'hello')).toBe(0)
    expect(deliver).toHaveBeenCalledWith('t1', 'hello')
    expect(queue.pending()).toBe(0)
  })

  it('holds a prompt while a dialog is up', () => {
    const { queue, deliver, ready } = setup(new Set())
    const queued = vi.fn()
    queue.onQueued = queued
    expect(queue.submit('t1', 'hello')).toBe(1)
    expect(deliver).not.toHaveBeenCalled()
    expect(queued).toHaveBeenCalledWith('t1', 1)

    ready.add('t1')
    queue.flush('t1')
    expect(deliver).toHaveBeenCalledWith('t1', 'hello')
    expect(queue.pending()).toBe(0)
  })

  it('keeps held prompts in the order they were sent', () => {
    const { queue, deliver, ready } = setup(new Set())
    queue.submit('t1', 'first')
    queue.submit('t1', 'second')
    expect(queue.submit('t1', 'third')).toBe(3)

    ready.add('t1')
    queue.flush('t1')
    expect(deliver.mock.calls.map((c) => c[1])).toEqual(['first', 'second', 'third'])
  })

  it('does not overtake a prompt already waiting for that tab', () => {
    const { queue, deliver, ready } = setup(new Set())
    queue.submit('t1', 'first')
    ready.add('t1')
    // the tab is ready again, but something is still queued ahead of this
    expect(queue.submit('t1', 'second')).toBe(2)
    expect(deliver).not.toHaveBeenCalled()
    queue.flush('t1')
    expect(deliver.mock.calls.map((c) => c[1])).toEqual(['first', 'second'])
  })

  it('flushing one tab leaves another alone', () => {
    const { queue, deliver, ready } = setup(new Set())
    queue.submit('t1', 'for one')
    queue.submit('t2', 'for two')
    ready.add('t1')
    queue.flush('t1')
    expect(deliver.mock.calls).toEqual([['t1', 'for one']])
    expect(queue.pending('t2')).toBe(1)
  })

  it('stops flushing if the tab stops being ready mid-drain', () => {
    const deliver = vi.fn()
    const ready = new Set(['t1'])
    const queue = new PromptQueue({
      deliver: (tabId, text) => {
        deliver(tabId, text)
        // the first prompt triggered a permission dialog
        ready.delete('t1')
      },
      ready: (tabId) => ready.has(tabId)
    })
    queue.submit('t1', 'first')
    queue.submit('t1', 'second')
    queue.flush('t1')
    expect(deliver.mock.calls.map((c) => c[1])).toEqual(['first'])
    expect(queue.pending('t1')).toBe(1)
  })

  it('reports each held prompt as it goes through', () => {
    const { queue, ready } = setup(new Set())
    const delivered: string[] = []
    queue.onDelivered = (_tabId, text) => delivered.push(text)
    queue.submit('t1', 'one')
    queue.submit('t1', 'two')
    ready.add('t1')
    queue.flush('t1')
    expect(delivered).toEqual(['one', 'two'])
  })

  it('forgets a tab that is going away', () => {
    const { queue, deliver, ready } = setup(new Set())
    queue.submit('t1', 'never sent')
    queue.forget('t1')
    ready.add('t1')
    queue.flush('t1')
    expect(deliver).not.toHaveBeenCalled()
    expect(queue.pending()).toBe(0)
  })

  it('flushing an empty queue does nothing', () => {
    const { queue, deliver } = setup()
    queue.flush('t1')
    expect(deliver).not.toHaveBeenCalled()
  })
})
