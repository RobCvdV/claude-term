import type { PushNotice } from './notifier'

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
/** Expo accepts batches; a handful of devices is well inside one request. */
export const MAX_BATCH = 100

export interface PushTarget {
  deviceId: string
  token: string
}

interface ExpoTicket {
  status?: string
  message?: string
  details?: { error?: string }
}

export interface PushSenderDeps {
  /** Injected so tests never touch the network. */
  fetch: typeof globalThis.fetch
  /** A token Expo has rejected for good — stop keeping it. */
  onTokenRejected: (deviceId: string) => void
  log?: (message: string) => void
}

/**
 * Sends notifications through Expo's push service, which forwards to APNs.
 *
 * Nothing here is essential: a push that fails means someone finds out when they
 * next open the app, so every failure is swallowed after being noted. The one
 * thing worth acting on is `DeviceNotRegistered`, which means the app was
 * uninstalled or its token rotated — keeping that token would mean sending to
 * nobody forever.
 */
export class PushSender {
  constructor(private readonly deps: PushSenderDeps) {}

  async send(targets: PushTarget[], notice: PushNotice): Promise<number> {
    if (targets.length === 0) return 0
    const batch = targets.slice(0, MAX_BATCH)
    const messages = batch.map((target) => ({
      to: target.token,
      title: notice.title,
      body: notice.body,
      data: notice.data,
      sound: 'default',
      // a prompt is blocking a session, so it should wake the screen
      priority: notice.kind === 'needs-attention' ? 'high' : 'normal'
    }))

    let response: Response
    try {
      response = await this.deps.fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages)
      })
    } catch (err) {
      this.deps.log?.(`[push] unreachable: ${String(err)}`)
      return 0
    }
    if (!response.ok) {
      this.deps.log?.(`[push] rejected with ${response.status}`)
      return 0
    }

    let tickets: ExpoTicket[] = []
    try {
      const body = (await response.json()) as { data?: unknown }
      if (Array.isArray(body.data)) tickets = body.data as ExpoTicket[]
    } catch {
      // delivered as far as we know; we just cannot read the receipts
      return batch.length
    }

    let delivered = 0
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'ok') {
        delivered++
        return
      }
      const target = batch[i]
      this.deps.log?.(`[push] ${target?.deviceId ?? '?'}: ${ticket.message ?? 'error'}`)
      if (ticket.details?.error === 'DeviceNotRegistered' && target) {
        this.deps.onTokenRejected(target.deviceId)
      }
    })
    return delivered
  }
}
