import type { TicketStatus } from '../shared/types'

/** Jira status of a branch's ticket, cache-only like the PR lookup: a stale
 *  entry refreshes in the background and the next git poll shows the result. */

const TTL_MS = 180_000
/** not connected / offline: ask rarely */
const TTL_ERROR_MS = 600_000

const TICKET_RE = /^(?:[^/]*\/)?([A-Z][A-Z0-9]+-\d+)(?:-.*)?$/

export function branchTicket(branch: string): string | null {
  return TICKET_RE.exec(branch)?.[1] ?? null
}

type Fetcher = (key: string) => Promise<TicketStatus | null>

let fetcher: Fetcher | null = null

/** Set at startup by the main process; without it every lookup is null. */
export function setTicketFetcher(f: Fetcher | null): void {
  fetcher = f
  cache.clear()
}

interface Entry {
  status: TicketStatus | null
  expiresAt: number
  inflight: boolean
}

const cache = new Map<string, Entry>()

export function ticketStatus(branch: string): TicketStatus | null {
  const key = branchTicket(branch)
  if (!key || !fetcher) return null
  const entry = cache.get(key)
  if (!entry || (entry.expiresAt < Date.now() && !entry.inflight)) void refresh(key, fetcher)
  return entry?.status ?? null
}

/** Drop cached statuses: one ticket after we moved it, all on (dis)connect. */
export function forgetTicket(key?: string): void {
  if (key) cache.delete(key)
  else cache.clear()
}

async function refresh(key: string, fetch: Fetcher): Promise<void> {
  const prev = cache.get(key)
  cache.set(key, { status: prev?.status ?? null, expiresAt: prev?.expiresAt ?? 0, inflight: true })
  try {
    const status = await fetch(key)
    cache.set(key, { status, expiresAt: Date.now() + TTL_MS, inflight: false })
  } catch {
    cache.set(key, {
      status: prev?.status ?? null,
      expiresAt: Date.now() + TTL_ERROR_MS,
      inflight: false
    })
  }
}
