import type { BookedWorklog } from './types'

/** How much of a day's ticket work already sits in Jira. */
export type DayBookedState = 'none' | 'partial' | 'full'

export function bookedKey(date: string, issueKey: string): string {
  return `${date}|${issueKey}`
}

/** Sum booked hours per date|issueKey. */
export function sumBookedByKey(booked: BookedWorklog[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of booked) {
    const k = bookedKey(w.date, w.issueKey)
    out[k] = (out[k] ?? 0) + w.hours
  }
  return out
}

/** Sum booked hours per date (for the day badges). */
export function sumBookedByDate(booked: BookedWorklog[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of booked) out[w.date] = (out[w.date] ?? 0) + w.hours
  return out
}

/**
 * Badge state for a day: nothing booked, partially booked (less than the
 * tracked ticket hours), or covered. Days without ticket work are 'full' —
 * there is nothing to book.
 */
export function dayBookedState(ticketTrackedHours: number, bookedHours: number): DayBookedState {
  if (ticketTrackedHours <= 0) return 'full'
  if (bookedHours <= 0) return 'none'
  // small tolerance so 3.99 tracked vs 4h booked counts as covered
  return bookedHours + 0.05 >= ticketTrackedHours ? 'full' : 'partial'
}

/** A day is pre-ticked for booking when any of its rows still has hours left. */
export function defaultDayChecked(rows: { toBook: number }[]): boolean {
  return rows.some((r) => r.toBook > 0)
}
