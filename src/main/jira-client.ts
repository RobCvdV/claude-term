import { safeStorage, app } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  BookResult,
  BookedWorklog,
  JiraStatus,
  JiraTodo,
  WorklogPlanEntry
} from '../shared/types'
import { todoJql } from '../shared/jira-labels'
import { adfToText, mapTodos } from './jira-todo-data'
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
  /** REST base that accepted the token — the site URL for classic API tokens,
   *  api.atlassian.com/ex/jira/<cloudId> for tokens created with scopes */
  base: string
}

interface Creds {
  email: string
  token: string
  accountId: string
  base: string
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
    return { email: s.email, token, accountId: s.accountId, base: s.base || SITE }
  } catch {
    return null
  }
}

function writeCreds(email: string, token: string, accountId: string, base: string): void {
  const enc = safeStorage.isEncryptionAvailable()
  const stored: StoredCreds = {
    email,
    token: enc
      ? safeStorage.encryptString(token).toString('base64')
      : Buffer.from(token, 'utf8').toString('base64'),
    enc,
    accountId,
    base
  }
  writeFileSync(credsPath(), JSON.stringify(stored), { mode: 0o600 })
}

async function jiraFetch(
  creds: Creds,
  path: string,
  init?: { method?: string; body?: object }
): Promise<Response> {
  return fetch(`${creds.base}${path}`, {
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

/** api.atlassian.com REST base for this site — the only base scoped tokens accept. */
async function gatewayBase(): Promise<string> {
  const res = await fetch(`${SITE}/_edge/tenant_info`)
  if (!res.ok) throw new Error(`could not resolve cloud id (${res.status})`)
  const info = (await res.json()) as { cloudId?: string }
  if (!info.cloudId) throw new Error('could not resolve cloud id')
  return `https://api.atlassian.com/ex/jira/${info.cloudId}`
}

/**
 * Validate the token against /myself and persist it (encrypted). Classic API
 * tokens authenticate on the site URL; tokens created WITH scopes only work on
 * the api.atlassian.com gateway — try the site first, then the gateway.
 */
export async function jiraConnect(
  email: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = basicAuth(email.trim(), token.trim())
  const tryBase = async (base: string): Promise<{ res: Response; me?: { accountId?: string } }> => {
    const res = await fetch(`${base}/rest/api/3/myself`, {
      headers: { Authorization: auth, Accept: 'application/json' }
    })
    return res.ok ? { res, me: (await res.json()) as { accountId?: string } } : { res }
  }
  try {
    let base = SITE
    let attempt = await tryBase(base)
    if (!attempt.me) {
      base = await gatewayBase()
      attempt = await tryBase(base)
    }
    if (!attempt.me) {
      const detail = await errorText(attempt.res)
      const hint =
        attempt.res.status === 401
          ? ' — check the email and token'
          : attempt.res.status === 403
            ? ' — a scoped token also needs the read:jira-user scope'
            : ''
      return { ok: false, error: `${detail}${hint}` }
    }
    if (!attempt.me.accountId) return { ok: false, error: 'Jira did not return an account id' }
    writeCreds(email.trim(), token.trim(), attempt.me.accountId, base)
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

const NOT_CONNECTED = 'Jira not connected — connect it in the activity overview (🕐)'
const TODO_LIMIT = 50

const todoCache = new Map<string, { at: number; todos: JiraTodo[] }>()

/** To-do tickets with these labels that are free or mine, in board order (60s cache). */
export async function fetchTodos(labels: string[]): Promise<{ todos: JiraTodo[]; error?: string }> {
  const creds = readCreds()
  if (!creds) return { todos: [], error: NOT_CONNECTED }
  const key = labels.join(',')
  const hit = todoCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { todos: hit.todos }
  try {
    const res = await jiraFetch(creds, '/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql: todoJql(labels),
        fields: ['summary', 'issuetype', 'priority', 'assignee'],
        maxResults: TODO_LIMIT
      }
    })
    if (!res.ok) throw new Error(await errorText(res))
    const todos = mapTodos(await res.json(), creds.accountId)
    todoCache.set(key, { at: Date.now(), todos })
    return { todos }
  } catch (e) {
    return { todos: hit?.todos ?? [], error: e instanceof Error ? e.message : String(e) }
  }
}

export interface TicketDetails {
  key: string
  summary: string
  type: string
  description: string
  assigneeId: string | null
  status: string
}

export async function fetchTicket(key: string): Promise<TicketDetails> {
  const creds = readCreds()
  if (!creds) throw new Error(NOT_CONNECTED)
  const res = await jiraFetch(
    creds,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype,description,assignee,status`
  )
  if (!res.ok) throw new Error(await errorText(res))
  const issue = (await res.json()) as {
    key?: string
    fields?: {
      summary?: string
      issuetype?: { name?: string }
      description?: unknown
      assignee?: { accountId?: string } | null
      status?: { name?: string }
    }
  }
  return {
    key: issue.key ?? key,
    summary: issue.fields?.summary ?? '',
    type: issue.fields?.issuetype?.name ?? '',
    description: adfToText(issue.fields?.description),
    assigneeId: issue.fields?.assignee?.accountId ?? null,
    status: issue.fields?.status?.name ?? ''
  }
}

/** Put the ticket on my name and move it to Active; returns what failed. */
export async function claimTicket(ticket: TicketDetails): Promise<string[]> {
  const creds = readCreds()
  if (!creds) return [NOT_CONNECTED]
  const warnings: string[] = []
  const path = `/rest/api/3/issue/${encodeURIComponent(ticket.key)}`
  if (ticket.assigneeId !== creds.accountId) {
    const res = await jiraFetch(creds, `${path}/assignee`, {
      method: 'PUT',
      body: { accountId: creds.accountId }
    })
    if (!res.ok) warnings.push(`assign: ${await errorText(res)}`)
  }
  if (ticket.status.toLowerCase() !== 'active') {
    const res = await jiraFetch(creds, `${path}/transitions`)
    if (!res.ok) {
      warnings.push(`move to Active: ${await errorText(res)}`)
    } else {
      const { transitions = [] } = (await res.json()) as {
        transitions?: { id: string; to?: { name?: string } }[]
      }
      const active = transitions.find((t) => t.to?.name?.toLowerCase() === 'active')
      if (!active) {
        warnings.push(`move to Active: no transition to Active from "${ticket.status}"`)
      } else {
        const done = await jiraFetch(creds, `${path}/transitions`, {
          method: 'POST',
          body: { transition: { id: active.id } }
        })
        if (!done.ok) warnings.push(`move to Active: ${await errorText(done)}`)
      }
    }
  }
  todoCache.clear()
  return warnings
}
