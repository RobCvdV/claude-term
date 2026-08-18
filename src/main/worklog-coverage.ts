import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { WorklogCoverage } from '../shared/types'

/**
 * Which stretches of which days are already settled in Jira.
 *
 * Booking a day is a statement about the whole day, not about an amount: a 12h
 * span of tracked activity booked as 8h leaves nothing to book. So each booking
 * records the WINDOW it settled (first→last activity of that day). Only activity
 * after that window — the evening shift you do decide to book separately — shows
 * up as unbooked again.
 */

const COVERAGE_PATH = join(homedir(), '.claude', 'activity-worklog-coverage.json')

/** The settled window of one day, folded from all its coverage records. */
export interface DayCoverage {
  fromTs: number
  toTs: number
  hours: number
}

export function readCoverage(): WorklogCoverage[] {
  if (!existsSync(COVERAGE_PATH)) return []
  try {
    const data = JSON.parse(readFileSync(COVERAGE_PATH, 'utf8')) as {
      coverage?: WorklogCoverage[]
    }
    return Array.isArray(data.coverage) ? data.coverage : []
  } catch {
    return []
  }
}

function writeCoverage(records: WorklogCoverage[]): void {
  try {
    writeFileSync(COVERAGE_PATH, JSON.stringify({ coverage: records }, null, 2))
  } catch {
    /* best effort — Jira has the worklog either way, only the window is lost */
  }
}

/** Fold the records of each day into one window (earliest start, latest end). */
export function coverageByDate(records: WorklogCoverage[]): Record<string, DayCoverage> {
  const out: Record<string, DayCoverage> = {}
  for (const r of records) {
    if (!r || typeof r.toTs !== 'number' || r.toTs <= 0) continue
    const cur = out[r.date]
    if (!cur) out[r.date] = { fromTs: r.fromTs, toTs: r.toTs, hours: r.hours || 0 }
    else {
      cur.fromTs = Math.min(cur.fromTs, r.fromTs)
      cur.toTs = Math.max(cur.toTs, r.toTs)
      cur.hours += r.hours || 0
    }
  }
  return out
}

/** Epoch seconds of the last moment of a local YYYY-MM-DD. */
function endOfLocalDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000)
}

export interface DaySpan {
  firstTs: number
  lastTs: number
}

/**
 * The window a fresh booking of `date` settles: from where the previous booking
 * left off (or the day's first work activity) to its last activity. Days with no
 * tracked work at all are settled up to now, so a hand-typed total still counts.
 */
export function nextWindow(
  date: string,
  span: DaySpan | undefined,
  prior: DayCoverage | undefined,
  nowSec: number
): { fromTs: number; toTs: number } {
  const first = span && span.firstTs > 0 ? span.firstTs : Math.min(endOfLocalDay(date), nowSec)
  const last = span && span.lastTs > 0 ? span.lastTs : Math.min(endOfLocalDay(date), nowSec)
  const fromTs = prior ? Math.max(prior.toTs, first) : first
  return { fromTs, toTs: Math.max(fromTs, last) }
}

/** Record the settled windows for the days that were just booked. */
export function recordCoverage(
  booked: { date: string; hours: number }[],
  spans: Record<string, DaySpan>,
  nowMs = Date.now()
): void {
  if (booked.length === 0) return
  const hoursByDate: Record<string, number> = {}
  for (const b of booked) hoursByDate[b.date] = (hoursByDate[b.date] ?? 0) + b.hours
  const existing = readCoverage()
  const prior = coverageByDate(existing)
  const nowSec = Math.floor(nowMs / 1000)
  const added: WorklogCoverage[] = Object.entries(hoursByDate).map(([date, hours]) => ({
    date,
    ...nextWindow(date, spans[date], prior[date], nowSec),
    hours,
    at: nowMs
  }))
  writeCoverage([...existing, ...added])
}
