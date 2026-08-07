import { safeStorage, app } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { BookResult, BookedWorklog, JiraStatus, WorklogPlanEntry } from '../shared/types'
import { basicAuth, buildWorklogBody, sinceDateFor, toBookedWorklogs } from './jira-helpers'
import type { JiraWorklogRaw } from './jira-helpers'
import { appendLoggedWorklogs } from './worklog-store'

const SITE = 'https://mendrix.atlassian.net'
const CACHE_TTL_MS = 60_000

interface StoredCreds {
  email: string
  /** base64 of the safeStorage-encrypted token (or of the raw token when enc=false) */
  token: string
  enc: boolean
  accountId: string
}

interface Creds {
  email: string
  token: string
  accountId: string
}

function credsPath(): string {
  return join(app.getPath('userData'), 'jira-credentials.json')
}

function readCreds(): Creds | null {
  const p = credsPath()
  if (!existsSync(p)) return null
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as StoredCreds
    const buf = Buffer.from(s.token, 'base64')
    const token = s.enc ? safeStorage.decryptString(buf) : buf.toString('utf8')
    return { email: s.email, token, accountId: s.accountId }
  } catch {
    return null
  }
}

function writeCreds(email: string, token: string, accountId: string): void {
  const enc = safeStorage.isEncryptionAvailable()
  const stored: StoredCreds = {
    email,
    token: enc
      ? safeStorage.encryptString(token).toString('base64')
      : Buffer.from(token, 'utf8').toString('base64'),
    enc,
    accountId
  }
  writeFileSync(credsPath(), JSON.stringify(stored), { mode: 0o600 })
}

async function jiraFetch(
  creds: Creds,
  path: string,
  init?: { method?: string; body?: object }
): Promise<Response> {
  return fetch(`${SITE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: basicAuth(creds.email, creds.token),
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {})
  })
}

async function errorText(res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> }
    detail = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join('; ')
  } catch {
    /* non-JSON error body */
  }
  return `Jira ${res.status}${detail ? `: ${detail}` : ''}`
}

export function jiraStatus(): JiraStatus {
  const creds = readCreds()
  return creds ? { connected: true, email: creds.email } : { connected: false }
}

/** Validate the token against /myself, then persist it (encrypted). */
export async function jiraConnect(
  email: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SITE}/rest/api/3/myself`, {
      headers: { Authorization: basicAuth(email.trim(), token.trim()), Accept: 'application/json' }
    })
    if (!res.ok) return { ok: false, error: await errorText(res) }
    const me = (await res.json()) as { accountId?: string }
    if (!me.accountId) return { ok: false, error: 'Jira did not return an account id' }
    writeCreds(email.trim(), token.trim(), me.accountId)
    bookedCache = null
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function jiraDisconnect(): void {
  try {
    unlinkSync(credsPath())
  } catch {
    /* already gone */
  }
  bookedCache = null
}

let bookedCache: { since: string; at: number; data: BookedWorklog[] } | null = null

export type BookedResult = { ok: true; booked: BookedWorklog[] } | { ok: false; error: string }

/** My worklogs within the trailing window, straight from Jira (60s cache). */
export async function fetchBooked(rangeDays: number): Promise<BookedResult> {
  const creds = readCreds()
  if (!creds) return { ok: false, error: 'Not connected to Jira' }
  const since = sinceDateFor(rangeDays)
  if (bookedCache && bookedCache.since <= since && Date.now() - bookedCache.at < CACHE_TTL_MS) {
    return { ok: true, booked: bookedCache.data.filter((w) => w.date >= since) }
  }
  try {
    const issueKeys = await searchWorkedIssues(creds, since)
    const all: BookedWorklog[] = []
    for (const key of issueKeys) {
      all.push(...(await fetchIssueWorklogs(creds, key, since)))
    }
    bookedCache = { since, at: Date.now(), data: all }
    return { ok: true, booked: all }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Issue keys I logged work on since the date (paginated JQL search). */
async function searchWorkedIssues(creds: Creds, since: string): Promise<string[]> {
  const keys: string[] = []
  let nextPageToken: string | undefined
  do {
    const res = await jiraFetch(creds, '/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql: `worklogAuthor = currentUser() AND worklogDate >= "${since}"`,
        fields: ['key'],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {})
      }
    })
    if (!res.ok) throw new Error(await errorText(res))
    const page = (await res.json()) as {
      issues?: { id?: string; key?: string }[]
      nextPageToken?: string
    }
    for (const i of page.issues ?? []) {
      const k = i.key ?? i.id
      if (k) keys.push(k)
    }
    nextPageToken = page.nextPageToken
  } while (nextPageToken)
  return keys
}

async function fetchIssueWorklogs(
  creds: Creds,
  issueKey: string,
  since: string
): Promise<BookedWorklog[]> {
  const out: BookedWorklog[] = []
  let startAt = 0
  for (;;) {
    const res = await jiraFetch(
      creds,
      `/rest/api/3/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=100`
    )
    if (!res.ok) throw new Error(await errorText(res))
    const page = (await res.json()) as { worklogs?: JiraWorklogRaw[]; total?: number }
    const raw = page.worklogs ?? []
    out.push(...toBookedWorklogs(issueKey, raw, creds.accountId, since))
    startAt += raw.length
    if (raw.length === 0 || startAt >= (page.total ?? 0)) break
  }
  return out
}

/**
 * Post the entries to Jira one by one; a failure doesn't stop the rest. Each
 * success is also appended to ~/.claude/activity-worklog-log.json so the local
 * audit trail (and the old Claude flow's idempotency) stays intact.
 */
export async function bookWorklogs(entries: WorklogPlanEntry[]): Promise<BookResult[]> {
  const creds = readCreds()
  if (!creds) {
    return entries.map((e) => ({ ...pick(e), ok: false, error: 'Not connected to Jira' }))
  }
  const results: BookResult[] = []
  for (const entry of entries) {
    try {
      const res = await jiraFetch(
        creds,
        `/rest/api/3/issue/${entry.issueKey}/worklog?notifyUsers=false`,
        { method: 'POST', body: buildWorklogBody(entry) }
      )
      if (!res.ok) {
        results.push({ ...pick(entry), ok: false, error: await errorText(res) })
        continue
      }
      const created = (await res.json()) as { id?: string }
      appendLoggedWorklogs([
        {
          date: entry.date,
          issueKey: entry.issueKey,
          hours: entry.hours,
          activity: entry.activity,
          worklogId: created.id ?? '',
          at: Date.now()
        }
      ])
      results.push({ ...pick(entry), ok: true })
    } catch (e) {
      results.push({ ...pick(entry), ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  bookedCache = null
  return results
}

function pick(e: WorklogPlanEntry): { date: string; issueKey: string; hours: number } {
  return { date: e.date, issueKey: e.issueKey, hours: e.hours }
}
