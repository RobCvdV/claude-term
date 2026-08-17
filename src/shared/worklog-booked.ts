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
 * there is nothing to book. A day that has been booked once is judged on the
 * work done AFTER that settled window, not on the amount booked: 12h of tracked
 * activity booked as 8h is done, not partial.
 */
export function dayBookedState(
  ticketTrackedHours: number,
  bookedHours: number,
  settled?: { unsettledHours: number }
): DayBookedState {
  if (settled) return settled.unsettledHours > 0.05 ? 'partial' : 'full'
  if (ticketTrackedHours <= 0) return 'full'
  if (bookedHours <= 0) return 'none'
  // small tolerance so 3.99 tracked vs 4h booked counts as covered
  return bookedHours + 0.05 >= ticketTrackedHours ? 'full' : 'partial'
}

/**
 * A day is pre-ticked for booking when it still has hours to book AND nothing
 * about it has been booked yet — a day with worklogs already in Jira is left
 * for the user to tick deliberately. A settled day (booked through the panel,
 * so its window is known) is the exception: only its unsettled tail is offered,
 * so it can be pre-ticked again for evening work.
 */
export function defaultDayChecked(
  rows: { toBook: number }[],
  day?: { bookedHours: number; settled: boolean }
): boolean {
  if (!rows.some((r) => r.toBook > 0)) return false
  if (!day) return true
  return day.settled || day.bookedHours <= 0
}
