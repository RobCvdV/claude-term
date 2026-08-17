import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { ActivityBucket, ActivityDay, ActivityReport } from '../shared/types'
import { isWorkPath } from '../shared/work-projects'
import { coverageByDate, readCoverage, type DayCoverage, type DaySpan } from './worklog-coverage'

/**
 * Aggregates the global activity heartbeat log written by
 * ~/.claude/hooks/log-activity.sh into per-ticket, per-day "engaged hours".
 *
 * Each log line is one heartbeat: {ts, event, session, cwd, branch}. We
 * reconstruct wall-clock engagement by walking a session's heartbeats in time
 * order and turning the gap between consecutive beats into a slice of engaged
 * time — but a gap longer than IDLE_CAP_SEC counts only up to the cap, so
 * stepping away from a session isn't billed. PostToolUse fires repeatedly
 * mid-turn, so long working turns stay fully counted; the cap only trims genuine
 * idle stretches between beats.
 *
 * Per-bucket hours SUM those slices (two sessions working in parallel is twice
 * the effort), but the workday length must not: it merges the work slices into
 * blocks instead — see workdaySeconds.
 */

const LOG_PATH = join(homedir(), '.claude', 'activity-hours.jsonl')
const IDLE_CAP_SEC = 5 * 60
/** Gaps up to this long inside the workday still count as working (a coffee, a
 *  call, a review in the browser); anything longer splits the day into blocks. */
const BREAK_TOLERANCE_SEC = 30 * 60
/** A settled day only re-opens for a real stretch of later work — a stray beat
 *  after the booked window is not an evening shift worth another worklog. */
const MIN_TAIL_SEC = 10 * 60
// Same shape statusline-command.sh uses: optional "prefix/" then TICKET, then
// optional "-description". Captures the ticket id (e.g. MTX-10302).
const TICKET_RE = /^(?:[^/]*\/)?([A-Z]+-\d+)(?:-.*)?$/

interface RawEvent {
  ts: number
  session: string
  cwd: string
  branch: string
}

interface Bucketed {
  key: string
  ticket: string | null
  label: string
  branch: string
  project: string
  /** billable work (a work checkout or a ticket branch) rather than a hobby repo */
  work: boolean
}

function classify(cwd: string, branch: string): Bucketed {
  const b = (branch || '').trim()
  const project = basename(cwd || '') || 'unknown'
  const m = b.match(TICKET_RE)
  const ticket = m ? m[1] : null
  // Ticket work aggregates across repos under one key; non-ticket work is kept
  // distinct per project+branch so personal/main-branch time isn't merged.
  const key = ticket ?? `${project}:${b || '—'}`
  const label = ticket ?? b ?? project
  return {
    key,
    ticket,
    label: label || project,
    branch: b,
    project,
    work: ticket !== null || isWorkPath(cwd)
  }
}

function localDate(tsSec: number): string {
  const d = new Date(tsSec * 1000)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Round up to the next 30 min — the granularity Jira worklogs use here. */
function ceilHalfHour(sec: number): number {
  return Math.ceil(sec / 1800) * 0.5
}

/** One bucket being accumulated: seconds plus every branch name seen for it. */
interface Acc {
  b: Bucketed
  sec: number
  /** the part of `sec` that falls after the day's settled window */
  unsettledSec: number
  branches: Set<string>
}

function toBucket({ b, sec, unsettledSec, branches }: Acc): ActivityBucket {
  return {
    key: b.key,
    ticket: b.ticket,
    label: b.label,
    branches: [...branches].sort(),
    project: b.project,
    hours: round2(sec / 3600),
    unsettledHours: round2(unsettledSec / 3600)
  }
}

/** Local YYYY-MM-DD of the oldest day included in a trailing rangeDays window. */
function cutoffDate(rangeDays: number, nowMs: number): string {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (Math.max(1, rangeDays) - 1))
  return localDate(Math.floor(d.getTime() / 1000))
}

/** One stretch of engaged time, attributed to the day it started in. */
interface Slice {
  date: string
  b: Bucketed
  start: number
  end: number
}

/** Turn raw heartbeats into engaged-time slices, per session timeline. */
function toSlices(events: RawEvent[]): Slice[] {
  const bySession = new Map<string, RawEvent[]>()
  for (const ev of events) {
    if (typeof ev.ts !== 'number') continue
    const arr = bySession.get(ev.session || '')
    if (arr) arr.push(ev)
    else bySession.set(ev.session || '', [ev])
  }
  const out: Slice[] = []
  for (const evs of bySession.values()) {
    evs.sort((a, z) => a.ts - z.ts)
    for (let i = 1; i < evs.length; i++) {
      const prev = classify(evs[i - 1].cwd, evs[i - 1].branch)
      const cur = classify(evs[i].cwd, evs[i].branch)
      // A context switch (branch/ticket change) breaks the timeline — don't
      // bridge time across it.
      if (prev.key !== cur.key) continue
      const delta = evs[i].ts - evs[i - 1].ts
      if (delta <= 0) continue
      const start = evs[i - 1].ts
      out.push({
        date: localDate(start),
        b: prev,
        start,
        end: start + Math.min(delta, IDLE_CAP_SEC)
      })
    }
  }
  return out
}

interface Block {
  start: number
  end: number
}

/** Merge slices into blocks, bridging gaps up to `tolerance` and dropping
 *  anything that ended before `from`. */
export function mergeBlocks(slices: Block[], tolerance: number, from = 0): Block[] {
  const arr = slices
    .map((s) => ({ start: Math.max(s.start, from), end: s.end }))
    .filter((s) => s.end > s.start)
    .sort((a, z) => a.start - z.start)
  const out: Block[] = []
  for (const s of arr) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + tolerance) {
      if (s.end > last.end) last.end = s.end
    } else out.push({ ...s })
  }
  return out
}

/** Workday length in seconds: work slices merged across short breaks, counted
 *  once however many sessions ran in parallel. `from` clips a settled window. */
function workdaySeconds(slices: Slice[], from = 0): number {
  return mergeBlocks(
    slices.filter((s) => s.b.work),
    BREAK_TOLERANCE_SEC,
    from
  ).reduce((sum, b) => sum + (b.end - b.start), 0)
}

/** First→last work activity per day (the window a booking settles). */
export function workSpans(events: RawEvent[]): Record<string, DaySpan> {
  const out: Record<string, DaySpan> = {}
  for (const s of toSlices(events)) {
    if (!s.b.work) continue
    const cur = out[s.date]
    if (!cur) out[s.date] = { firstTs: s.start, lastTs: s.end }
    else {
      if (s.start < cur.firstTs) cur.firstTs = s.start
      if (s.end > cur.lastTs) cur.lastTs = s.end
    }
  }
  return out
}

export interface AggregateOptions {
  rangeDays: number
  /** settled windows per date, from the worklog coverage store */
  coverage?: Record<string, DayCoverage>
  nowMs?: number
}

export function aggregateActivity(events: RawEvent[], opts: AggregateOptions): ActivityReport {
  const { rangeDays, coverage = {}, nowMs = Date.now() } = opts
  const slices = toSlices(events)

  // perDay: date -> (bucket key -> accumulated seconds + branches seen)
  const perDay = new Map<string, Map<string, Acc>>()
  const perDaySlices = new Map<string, Slice[]>()
  for (const s of slices) {
    let day = perDay.get(s.date)
    if (!day) {
      day = new Map()
      perDay.set(s.date, day)
      perDaySlices.set(s.date, [])
    }
    perDaySlices.get(s.date)!.push(s)
    const settledTo = coverage[s.date]?.toTs ?? 0
    const sec = s.end - s.start
    const unsettledSec = Math.max(0, s.end - Math.max(s.start, settledTo))
    const cur = day.get(s.b.key)
    if (cur) {
      cur.sec += sec
      cur.unsettledSec += unsettledSec
      if (s.b.branch) cur.branches.add(s.b.branch)
    } else {
      day.set(s.b.key, {
        b: s.b,
        sec,
        unsettledSec,
        branches: new Set(s.b.branch ? [s.b.branch] : [])
      })
    }
  }

  const spans = workSpans(events)
  const cutoff = cutoffDate(rangeDays, nowMs)
  const dates = [...perDay.keys()]
    .filter((d) => d >= cutoff)
    .sort()
    .reverse()

  const days: ActivityDay[] = dates.map((date) => {
    const buckets = [...perDay.get(date)!.values()]
      .map(toBucket)
      .filter((x) => x.hours > 0)
      .sort((a, z) => z.hours - a.hours)
    const totalHours = round2(buckets.reduce((s, x) => s + x.hours, 0))
    const daySlices = perDaySlices.get(date) ?? []
    const settled = coverage[date]
    const span = spans[date]
    const openSec = workdaySeconds(daySlices, settled?.toTs ?? 0)
    return {
      date,
      totalHours,
      buckets,
      firstTs: span?.firstTs ?? 0,
      lastTs: span?.lastTs ?? 0,
      workHours: round2(workdaySeconds(daySlices) / 3600),
      settledFromTs: settled?.fromTs ?? 0,
      settledToTs: settled?.toTs ?? 0,
      settledHours: settled?.hours ?? 0,
      suggestedHours: settled && openSec < MIN_TAIL_SEC ? 0 : ceilHalfHour(openSec)
    }
  })

  // Totals across the whole window, per bucket key.
  const totalsMap = new Map<string, Acc>()
  for (const date of dates) {
    for (const acc of perDay.get(date)!.values()) {
      const cur = totalsMap.get(acc.b.key)
      if (cur) {
        cur.sec += acc.sec
        cur.unsettledSec += acc.unsettledSec
        for (const br of acc.branches) cur.branches.add(br)
      } else {
        totalsMap.set(acc.b.key, { ...acc, branches: new Set(acc.branches) })
      }
    }
  }
  const totals = [...totalsMap.values()]
    .map(toBucket)
    .filter((x) => x.hours > 0)
    .sort((a, z) => z.hours - a.hours)
  const totalHours = round2(totals.reduce((s, x) => s + x.hours, 0))

  return { rangeDays, totalHours, days, totals }
}

function readEvents(): RawEvent[] {
  if (!existsSync(LOG_PATH)) return []
  let text = ''
  try {
    text = readFileSync(LOG_PATH, 'utf8')
  } catch {
    return []
  }
  const out: RawEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as RawEvent
      if (typeof ev.ts !== 'number') continue
      out.push({ ts: ev.ts, session: ev.session || '', cwd: ev.cwd || '', branch: ev.branch || '' })
    } catch {
      /* skip a malformed / partially-written line */
    }
  }
  return out
}

export function buildActivityReport(rangeDays: number): ActivityReport {
  return aggregateActivity(readEvents(), {
    rangeDays,
    coverage: coverageByDate(readCoverage())
  })
}

/** First→last work activity of each day, for recording settled windows. */
export function workSpansForDates(dates: string[]): Record<string, DaySpan> {
  const wanted = new Set(dates)
  const all = workSpans(readEvents())
  const out: Record<string, DaySpan> = {}
  for (const [date, span] of Object.entries(all)) if (wanted.has(date)) out[date] = span
  return out
}
