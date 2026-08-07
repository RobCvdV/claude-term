import type { BookedWorklog, WorklogPlanEntry } from '../shared/types'

/** Pure request/response shaping for the Jira REST client — no Electron, no I/O. */

export function basicAuth(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
}

/** Local YYYY-MM-DD of a Date. */
export function localDateOf(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

/** Jira's `started` format: yyyy-MM-ddTHH:mm:ss.SSS±HHMM (offset without colon). */
function jiraTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin < 0 ? '-' : '+'
  const abs = Math.abs(offMin)
  return (
    `${localDateOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  )
}

/** 09:00 local on the given YYYY-MM-DD, with that date's UTC offset (DST-safe). */
export function startedAt0900(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return jiraTimestamp(new Date(y, m - 1, d, 9, 0, 0))
}

/** Body for POST /issue/{key}/worklog. */
export function buildWorklogBody(entry: WorklogPlanEntry): object {
  return {
    started: startedAt0900(entry.date),
    timeSpentSeconds: Math.round(entry.hours * 3600),
    comment: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: entry.activity }] }]
    }
  }
}

/** Flatten an ADF comment to plain text (best effort). */
export function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  if (Array.isArray(n.content)) return n.content.map(adfText).join('')
  return ''
}

export interface JiraWorklogRaw {
  id?: string
  author?: { accountId?: string }
  started?: string
  timeSpentSeconds?: number
  comment?: unknown
}

/**
 * Convert one issue's raw worklogs to BookedWorklog[], keeping only mine that
 * started on/after sinceDate (compared on the LOCAL calendar date).
 */
export function toBookedWorklogs(
  issueKey: string,
  worklogs: JiraWorklogRaw[],
  myAccountId: string,
  sinceDate: string
): BookedWorklog[] {
  const out: BookedWorklog[] = []
  for (const w of worklogs) {
    if (w.author?.accountId !== myAccountId) continue
    if (!w.started || typeof w.timeSpentSeconds !== 'number') continue
    const started = new Date(w.started)
    if (isNaN(started.getTime())) continue
    const date = localDateOf(started)
    if (date < sinceDate) continue
    const comment = adfText(w.comment)
    out.push({
      date,
      issueKey,
      hours: w.timeSpentSeconds / 3600,
      worklogId: w.id ?? '',
      ...(comment ? { comment } : {})
    })
  }
  return out
}

/** Local YYYY-MM-DD of the oldest day in a trailing rangeDays window. */
export function sinceDateFor(rangeDays: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (Math.max(1, rangeDays) - 1))
  return localDateOf(d)
}
