import { describe, expect, it, vi } from 'vitest'
import { EXPO_PUSH_URL, MAX_BATCH, PushSender } from './push-sender'
import type { PushNotice } from './notifier'

const notice: PushNotice = {
  tabId: 't1',
  kind: 'needs-attention',
  title: 'Claude needs your input',
  body: 'thing',
  data: { tabId: 't1', kind: 'needs-attention' }
}

function reply(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body
  } as unknown as Response
}

function setup(fetchImpl: typeof globalThis.fetch): {
  sender: PushSender
  rejected: string[]
  logs: string[]
} {
  const rejected: string[] = []
  const logs: string[] = []
  const sender = new PushSender({
    fetch: fetchImpl,
    onTokenRejected: (deviceId) => rejected.push(deviceId),
    log: (m) => logs.push(m)
  })
  return { sender, rejected, logs }
}

const ok = (n = 1): typeof globalThis.fetch =>
  vi.fn(async () => reply({ data: Array.from({ length: n }, () => ({ status: 'ok' })) })) as never

describe('PushSender', () => {
  it('sends nothing when there is nobody to send to', async () => {
    const fetchSpy = vi.fn()
    const { sender } = setup(fetchSpy as never)
    expect(await sender.send([], notice)).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts one message per device, carrying only the vague body', async () => {
    const fetchSpy = vi.fn(async () => reply({ data: [{ status: 'ok' }, { status: 'ok' }] }))
    const { sender } = setup(fetchSpy as never)
    const sent = await sender.send(
      [
        { deviceId: 'd1', token: 'ExponentPushToken[a]' },
        { deviceId: 'd2', token: 'ExponentPushToken[b]' }
      ],
      notice
    )
    expect(sent).toBe(2)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(EXPO_PUSH_URL)
    const body = JSON.parse(init.body as string)
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({
      to: 'ExponentPushToken[a]',
      title: 'Claude needs your input',
      body: 'thing',
      data: { tabId: 't1', kind: 'needs-attention' },
      priority: 'high'
    })
  })

  it('does not wake the screen for a session merely finishing', async () => {
    const fetchSpy = vi.fn(async () => reply({ data: [{ status: 'ok' }] }))
    const { sender } = setup(fetchSpy as never)
    await sender.send([{ deviceId: 'd1', token: 't' }], { ...notice, kind: 'idle' })
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    )
    expect(body[0].priority).toBe('normal')
  })

  it('forgets a token Expo says is gone for good', async () => {
    const fetchSpy = vi.fn(async () =>
      reply({
        data: [
          { status: 'ok' },
          {
            status: 'error',
            message: 'not registered',
            details: { error: 'DeviceNotRegistered' }
          }
        ]
      })
    )
    const { sender, rejected } = setup(fetchSpy as never)
    const sent = await sender.send(
      [
        { deviceId: 'good', token: 'a' },
        { deviceId: 'stale', token: 'b' }
      ],
      notice
    )
    expect(sent).toBe(1)
    expect(rejected).toEqual(['stale'])
  })

  it('keeps a token that failed for some other reason', async () => {
    const fetchSpy = vi.fn(async () =>
      reply({ data: [{ status: 'error', message: 'rate limited' }] })
    )
    const { sender, rejected, logs } = setup(fetchSpy as never)
    expect(await sender.send([{ deviceId: 'd1', token: 'a' }], notice)).toBe(0)
    expect(rejected).toEqual([])
    expect(logs.join(' ')).toContain('rate limited')
  })

  it('shrugs off an unreachable push service', async () => {
    const { sender, logs } = setup(
      vi.fn(async () => {
        throw new Error('offline')
      }) as never
    )
    expect(await sender.send([{ deviceId: 'd1', token: 'a' }], notice)).toBe(0)
    expect(logs.join(' ')).toContain('unreachable')
  })

  it('shrugs off a non-2xx answer', async () => {
    const { sender, logs } = setup(vi.fn(async () => reply({}, false, 503)) as never)
    expect(await sender.send([{ deviceId: 'd1', token: 'a' }], notice)).toBe(0)
    expect(logs.join(' ')).toContain('503')
  })

  it('assumes the best when the receipts are unreadable', async () => {
    const { sender } = setup(
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json')
        }
      })) as never
    )
    expect(await sender.send([{ deviceId: 'd1', token: 'a' }], notice)).toBe(1)
  })

  it('does not send more than one batch worth at a time', async () => {
    const targets = Array.from({ length: MAX_BATCH + 20 }, (_, i) => ({
      deviceId: `d${i}`,
      token: `t${i}`
    }))
    const fetchSpy = ok(MAX_BATCH)
    const { sender } = setup(fetchSpy)
    await sender.send(targets, notice)
    const body = JSON.parse(
      (fetchSpy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
        .body as string
    )
    expect(body).toHaveLength(MAX_BATCH)
  })
})
