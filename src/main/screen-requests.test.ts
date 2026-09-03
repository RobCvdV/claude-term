import { describe, expect, it, vi } from 'vitest'
import { ScreenRequests } from './screen-requests'

describe('ScreenRequests', () => {
  it('resolves with what the renderer sent back', async () => {
    let seen: { id: string; tabId: string } | null = null
    const screens = new ScreenRequests((id, tabId) => (seen = { id, tabId }))
    const pending = screens.request('t1')
    expect(seen!.tabId).toBe('t1')
    screens.resolve(seen!.id, ['> hello', '  world'])
    await expect(pending).resolves.toEqual(['> hello', '  world'])
    expect(screens.outstanding()).toBe(0)
  })

  it('gives up rather than hanging when nobody answers', async () => {
    const screens = new ScreenRequests(() => {}, 20)
    await expect(screens.request('t1')).resolves.toBeNull()
    expect(screens.outstanding()).toBe(0)
  })

  it('settles at once when there is no window to ask', async () => {
    const screens = new ScreenRequests(() => {
      throw new Error('no window')
    })
    await expect(screens.request('t1')).resolves.toBeNull()
  })

  it('ignores a reply that arrives after giving up', async () => {
    let id = ''
    const screens = new ScreenRequests((requestId) => (id = requestId), 20)
    await expect(screens.request('t1')).resolves.toBeNull()
    expect(() => screens.resolve(id, ['late'])).not.toThrow()
  })

  it('ignores a reply it never asked for', () => {
    const screens = new ScreenRequests(() => {})
    expect(() => screens.resolve('made-up', ['x'])).not.toThrow()
  })

  it('keeps concurrent requests apart', async () => {
    const ids: string[] = []
    const screens = new ScreenRequests((id) => ids.push(id))
    const first = screens.request('t1')
    const second = screens.request('t2')
    expect(new Set(ids).size).toBe(2)
    screens.resolve(ids[1], ['second'])
    screens.resolve(ids[0], ['first'])
    await expect(first).resolves.toEqual(['first'])
    await expect(second).resolves.toEqual(['second'])
  })

  it('answers everything outstanding when the window goes away', async () => {
    const screens = new ScreenRequests(() => {})
    const a = screens.request('t1')
    const b = screens.request('t2')
    screens.abandonAll()
    await expect(a).resolves.toBeNull()
    await expect(b).resolves.toBeNull()
    expect(screens.outstanding()).toBe(0)
  })

  it('does not leave a timer holding the process open', async () => {
    const unref = vi.fn()
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      const t = { unref } as unknown as NodeJS.Timeout
      void fn
      void ms
      return t
    }) as unknown as typeof setTimeout)
    const screens = new ScreenRequests(() => {})
    void screens.request('t1')
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })
})
