/** Worklog dispatch math — shared by the renderer (live preview) and anyone
 *  else who needs the exact same split. Pure, no I/O. */

/** Jira worklogs here are only as fine-grained as 30 minutes. */
export const WORKLOG_STEP_HOURS = 0.5

export interface DispatchInput {
  id: string
  /** tracked (actual) engaged hours for this ticket */
  actual: number
}

export interface DispatchResult {
  id: string
  hours: number
}

/**
 * Divide `dayTotalHours` across the items in proportion to their tracked hours,
 * in 30-minute increments, so the results sum EXACTLY to the day total (itself
 * snapped to the nearest 30 min). Largest-remainder rounding. Items with no
 * tracked time get 0.
 */
export function dispatchHours(dayTotalHours: number, items: DispatchInput[]): DispatchResult[] {
  const totalUnits = Math.max(0, Math.round(dayTotalHours / WORKLOG_STEP_HOURS))
  const sum = items.reduce((s, i) => s + Math.max(0, i.actual), 0)
  if (totalUnits === 0 || sum <= 0) return items.map((i) => ({ id: i.id, hours: 0 }))

  const rows = items.map((i) => {
    const raw = (totalUnits * Math.max(0, i.actual)) / sum
    const units = Math.floor(raw)
    return { id: i.id, units, rem: raw - units }
  })
  let leftover = totalUnits - rows.reduce((s, r) => s + r.units, 0)
  // hand the remaining 30-min blocks to the biggest remainders first
  const order = [...rows].sort((a, z) => z.rem - a.rem)
  for (let i = 0; i < order.length && leftover > 0; i++) {
    order[i].units++
    leftover--
  }
  const byId = new Map(rows.map((r) => [r.id, r.units]))
  return items.map((i) => ({ id: i.id, hours: (byId.get(i.id) ?? 0) * WORKLOG_STEP_HOURS }))
}

export interface RemainingInput extends DispatchInput {
  /** hours already booked in Jira for this ticket on this day */
  booked: number
  /** user override of the hours to book now; wins over the calculated split */
  pinned?: number
}

export interface RemainingResult {
  id: string
  /** proportional end-of-day target (booked + toBook aims at this) */
  target: number
  /** hours still to book now — what actually gets posted */
  toBook: number
}

/**
 * Like dispatchHours, but aware of hours already booked in Jira and of per-row
 * user overrides. The day total is the END target for the day: pinned rows
 * claim `booked + pinned`, the rest of the target is split across unpinned rows
 * in proportion to tracked hours, and each row books only what its target still
 * misses (never negative — over-booked tickets just book nothing more).
 */
export function dispatchRemaining(
  dayTotalHours: number,
  items: RemainingInput[]
): RemainingResult[] {
  const total = snapToStep(dayTotalHours)
  const pinned = items.filter((i) => i.pinned !== undefined)
  const unpinned = items.filter((i) => i.pinned === undefined)
  const pinnedClaim = pinned.reduce(
    (s, i) => s + Math.max(0, i.booked) + snapToStep(i.pinned ?? 0),
    0
  )
  const pool = Math.max(0, total - pinnedClaim)
  const targets = new Map(dispatchHours(pool, unpinned).map((r) => [r.id, r.hours]))
  return items.map((i) => {
    if (i.pinned !== undefined) {
      const toBook = snapToStep(i.pinned)
      return { id: i.id, target: Math.max(0, i.booked) + toBook, toBook }
    }
    const target = targets.get(i.id) ?? 0
    return { id: i.id, target, toBook: snapToStep(Math.max(0, target - Math.max(0, i.booked))) }
  })
}

/** Snap an arbitrary hours value to the nearest 30-min step (>= 0). */
export function snapToStep(hours: number): number {
  return Math.max(0, Math.round(hours / WORKLOG_STEP_HOURS) * WORKLOG_STEP_HOURS)
}

/** Format hours (a 0.5 multiple) as a Jira timeSpent string, e.g. "2h 30m". */
export function formatTimeSpent(hours: number): string {
  const totalMin = Math.round(hours * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}
