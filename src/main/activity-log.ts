import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { ActivityBucket, ActivityDay, ActivityReport } from '../shared/types'

/**
 * Aggregates the global activity heartbeat log written by
 * ~/.claude/hooks/log-activity.sh into per-ticket, per-day "engaged hours".
 *
 * Each log line is one heartbeat: {ts, event, session, cwd, branch}. We
 * reconstruct wall-clock engagement by walking a session's heartbeats in time
 * order and summing the gap between consecutive beats — but a gap longer than
 * IDLE_CAP_SEC counts only up to the cap, so stepping away from a session isn't
 * billed. PostToolUse fires repeatedly mid-turn, so long working turns stay
 * fully counted; the cap only trims genuine idle stretches between beats.
 */

const LOG_PATH = join(homedir(), '.claude', 'activity-hours.jsonl')
const IDLE_CAP_SEC = 5 * 60
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
  project: string
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
  return { key, ticket, label: label || project, project }
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

function toBucket(b: Bucketed, sec: number): ActivityBucket {
  return { key: b.key, ticket: b.ticket, label: b.label, project: b.project, hours: round2(sec / 3600) }
}

/** Local YYYY-MM-DD of the oldest day included in a trailing rangeDays window. */
function cutoffDate(rangeDays: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (Math.max(1, rangeDays) - 1))
  return localDate(Math.floor(d.getTime() / 1000))
}

interface ParsedBeat {
  ts: number
  session: string
  b: Bucketed
}

function readBeats(): ParsedBeat[] {
  if (!existsSync(LOG_PATH)) return []
  let text = ''
  try {
    text = readFileSync(LOG_PATH, 'utf8')
  } catch {
    return []
  }
  const out: ParsedBeat[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as RawEvent
      if (typeof ev.ts !== 'number') continue
      out.push({ ts: ev.ts, session: ev.session || '', b: classify(ev.cwd, ev.branch) })
    } catch {
      /* skip a malformed / partially-written line */
    }
  }
  return out
}

export function buildActivityReport(rangeDays: number): ActivityReport {
  const beats = readBeats()

  // Walk each session as its own timeline so concurrent sessions don't interleave.
  const bySession = new Map<string, ParsedBeat[]>()
  for (const beat of beats) {
    const arr = bySession.get(beat.session)
    if (arr) arr.push(beat)
    else bySession.set(beat.session, [beat])
  }

  // perDay: date -> (bucket key -> accumulated seconds)
  const perDay = new Map<string, Map<string, { b: Bucketed; sec: number }>>()
  const add = (date: string, b: Bucketed, sec: number): void => {
    let day = perDay.get(date)
    if (!day) {
      day = new Map()
      perDay.set(date, day)
    }
    const cur = day.get(b.key)
    if (cur) cur.sec += sec
    else day.set(b.key, { b, sec })
  }

  for (const evs of bySession.values()) {
    evs.sort((a, z) => a.ts - z.ts)
    for (let i = 1; i < evs.length; i++) {
      const prev = evs[i - 1]
      const cur = evs[i]
      // A context switch (branch/ticket change) breaks the timeline — don't
      // bridge time across it.
      if (prev.b.key !== cur.b.key) continue
      const delta = cur.ts - prev.ts
      if (delta <= 0) continue
      add(localDate(prev.ts), prev.b, Math.min(delta, IDLE_CAP_SEC))
    }
  }

  const cutoff = cutoffDate(rangeDays)
  const dates = [...perDay.keys()].filter((d) => d >= cutoff).sort().reverse()

  const days: ActivityDay[] = dates.map((date) => {
    const buckets = [...perDay.get(date)!.values()]
      .map(({ b, sec }) => toBucket(b, sec))
      .filter((x) => x.hours > 0)
      .sort((a, z) => z.hours - a.hours)
    const totalHours = round2(buckets.reduce((s, x) => s + x.hours, 0))
    return { date, totalHours, buckets }
  })

  // Totals across the whole window, per bucket key.
  const totalsMap = new Map<string, { b: Bucketed; sec: number }>()
  for (const date of dates) {
    for (const { b, sec } of perDay.get(date)!.values()) {
      const cur = totalsMap.get(b.key)
      if (cur) cur.sec += sec
      else totalsMap.set(b.key, { b, sec })
    }
  }
  const totals = [...totalsMap.values()]
    .map(({ b, sec }) => toBucket(b, sec))
    .filter((x) => x.hours > 0)
    .sort((a, z) => z.hours - a.hours)
  const totalHours = round2(totals.reduce((s, x) => s + x.hours, 0))

  return { rangeDays, totalHours, days, totals }
}
