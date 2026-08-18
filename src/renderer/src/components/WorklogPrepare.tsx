import { useEffect, useMemo, useState } from 'react'
import type {
  ActivityReport,
  BookResult,
  BookedWorklog,
  LoggedWorklog,
  WorklogActivity,
  WorklogPlanEntry
} from '../../../shared/types'
import { dispatchRemaining, snapToStep } from '../../../shared/worklog'
import { bookedKey, defaultDayChecked } from '../../../shared/worklog-booked'

interface Props {
  report: ActivityReport
  logged: LoggedWorklog[]
  /** my worklogs straight from Jira, null while loading / not connected */
  booked: BookedWorklog[] | null
  jiraConnected: boolean
  onRefreshBooked: () => void
  onMessage: (text: string) => void
  onFillPrompt: (text: string) => void
  onClose: () => void
}

const ACTIVITIES: WorklogActivity[] = ['coding', 'investigate', 'testing', 'reviewing']

function fmtHours(h: number): string {
  if (h <= 0) return '0h'
  const totalMin = Math.round(h * 60)
  const hh = Math.floor(totalMin / 60)
  const mm = totalMin % 60
  if (hh === 0) return `${mm}m`
  if (mm === 0) return `${hh}h`
  return `${hh}h ${mm}m`
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

interface Row {
  ticket: string
  branches: string[]
  project: string
  /** hours still open for booking (the whole day, or the tail after a settled window) */
  actual: number
  /** engaged hours this ticket got all day */
  tracked: number
  booked: number
  toBook: number
}

export function WorklogPrepare({
  report,
  logged,
  booked,
  jiraConnected,
  onRefreshBooked,
  onMessage,
  onFillPrompt,
  onClose
}: Props): React.JSX.Element {
  const [dayTotals, setDayTotals] = useState<Record<string, number>>({})
  const [activities, setActivities] = useState<Record<string, WorklogActivity>>({})
  const [checkedDays, setCheckedDays] = useState<Record<string, boolean>>({})
  /** per date|ticket user override of the hours to book */
  const [pins, setPins] = useState<Record<string, number>>({})
  /** per date|ticket outcome of the last direct-booking run */
  const [results, setResults] = useState<Record<string, BookResult>>({})
  const [booking, setBooking] = useState(false)
  // legacy hand-to-Claude flow (used while Jira isn't connected)
  const [prepared, setPrepared] = useState(false)

  // Hours already in Jira per date|issue. Falls back to the local posted-log
  // while not connected so ✓ badges keep working offline.
  const bookedByKey = useMemo(() => {
    const out: Record<string, number> = {}
    if (booked) {
      for (const w of booked) {
        const k = bookedKey(w.date, w.issueKey)
        out[k] = (out[k] ?? 0) + w.hours
      }
    } else {
      for (const l of logged) {
        const k = bookedKey(l.date, l.issueKey)
        out[k] = (out[k] ?? 0) + l.hours
      }
    }
    return out
  }, [booked, logged])

  const rowsFor = (
    date: string,
    totals: Record<string, number>,
    pinned: Record<string, number>
  ): Row[] => {
    const day = report.days.find((d) => d.date === date)
    if (!day) return []
    const tickets = day.buckets.filter((b) => b.ticket)
    const total = totals[date] ?? day.suggestedHours
    // On a settled day the earlier booking already covers its window, so what's
    // in Jira isn't subtracted again — only the work after it is up for booking.
    const settled = day.settledToTs > 0
    const hasTail = tickets.some((b) => b.unsettledHours > 0)
    const open = (b: (typeof tickets)[number]): number =>
      settled && hasTail ? b.unsettledHours : b.hours
    const split = dispatchRemaining(
      total,
      tickets.map((b) => ({
        id: b.key,
        actual: open(b),
        booked: settled ? 0 : (bookedByKey[bookedKey(date, b.ticket as string)] ?? 0),
        pinned: pinned[bookedKey(date, b.ticket as string)]
      }))
    )
    const byId = new Map(split.map((s) => [s.id, s]))
    return tickets.map((b) => ({
      ticket: b.ticket as string,
      branches: b.branches,
      project: b.project,
      actual: open(b),
      tracked: b.hours,
      booked: bookedByKey[bookedKey(date, b.ticket as string)] ?? 0,
      toBook: byId.get(b.key)?.toBook ?? 0
    }))
  }

  // Reset the editable state whenever the report (range) or the booked data
  // changes; day checkboxes default to "has hours left to book".
  useEffect(() => {
    const totals: Record<string, number> = {}
    for (const d of report.days) totals[d.date] = d.suggestedHours
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived state off a prop change; costs one extra render when the range switches
    setDayTotals(totals)
    setActivities({})
    setPins({})
    setPrepared(false)
    const checked: Record<string, boolean> = {}
    for (const d of report.days) {
      const rows = rowsFor(d.date, totals, {})
      checked[d.date] = defaultDayChecked(rows, {
        bookedHours: rows.reduce((s, r) => s + r.booked, 0),
        settled: d.settledToTs > 0
      })
    }
    setCheckedDays(checked)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowsFor reads only report + bookedByKey
  }, [report, bookedByKey])

  const actKey = (date: string, ticket: string): string => `${date}|${ticket}`
  const getActivity = (date: string, ticket: string): WorklogActivity =>
    activities[actKey(date, ticket)] ?? 'coding'

  const buildEntries = (): WorklogPlanEntry[] => {
    const entries: WorklogPlanEntry[] = []
    for (const day of report.days) {
      if (!checkedDays[day.date]) continue
      for (const row of rowsFor(day.date, dayTotals, pins)) {
        if (row.toBook <= 0) continue
        entries.push({
          date: day.date,
          issueKey: row.ticket,
          hours: row.toBook,
          activity: getActivity(day.date, row.ticket)
        })
      }
    }
    return entries
  }

  const bookNow = (): void => {
    const entries = buildEntries()
    if (entries.length === 0 || booking) return
    setBooking(true)
    setResults({})
    window.claudeTerm.jiraBook(entries).then((res) => {
      setBooking(false)
      const map: Record<string, BookResult> = {}
      for (const r of res) map[bookedKey(r.date, r.issueKey)] = r
      setResults(map)
      const okCount = res.filter((r) => r.ok).length
      const failed = res.filter((r) => !r.ok)
      onMessage(
        failed.length === 0
          ? `Booked ${okCount} worklog${okCount === 1 ? '' : 's'} to Jira.`
          : `Booked ${okCount} of ${res.length} worklogs — ${failed.length} failed (see rows).`
      )
      onRefreshBooked()
    })
  }

  // Legacy flow: write the plan file, then tee up the "log my hours" prompt.
  const prepare = (): void => {
    const entries = buildEntries()
    window.claudeTerm.saveWorklogPlan({ generatedAt: Date.now(), entries }).then(() => {
      setPrepared(true)
      onMessage(
        entries.length > 0
          ? `Prepared ${entries.length} worklog line${entries.length === 1 ? '' : 's'} — ask Claude to “log my hours”.`
          : 'Nothing to prepare.'
      )
    })
  }

  const finish = (): void => {
    onFillPrompt(
      'Log my hours — post the prepared worklog at ~/.claude/activity-worklog-plan.json ' +
        'to Jira. Use those entries exactly as prepared; do not re-analyze my activity. ' +
        'Skip any already recorded in ~/.claude/activity-worklog-log.json.'
    )
    onClose()
  }

  const totalToBook = buildEntries().reduce((s, e) => s + e.hours, 0)
  const daysToBook = report.days.filter(
    (d) => checkedDays[d.date] && rowsFor(d.date, dayTotals, pins).some((r) => r.toBook > 0)
  ).length

  return (
    <div className="wl">
      <div className="wl-intro">
        {jiraConnected
          ? 'Tick the days to book, review the split, then book straight to Jira. Booking a day settles it — only work done after that comes back as unbooked.'
          : 'Review the split, then prepare it — the hours are handed to Claude to post to Jira.'}
      </div>

      {report.days.map((day) => {
        const rows = rowsFor(day.date, dayTotals, pins)
        const nonTicket = day.buckets.filter((b) => !b.ticket)
        const span = day.lastTs > day.firstTs ? (day.lastTs - day.firstTs) / 3600 : 0
        const total = dayTotals[day.date] ?? day.suggestedHours
        const hasTickets = rows.length > 0
        const checked = checkedDays[day.date] ?? false
        const dayBooked = rows.reduce((s, r) => s + r.booked, 0)
        return (
          <div className={`wl-day ${checked ? '' : 'off'}`} key={day.date}>
            <div className="wl-day-head">
              <input
                type="checkbox"
                className="wl-day-check"
                checked={checked}
                disabled={!hasTickets}
                title={hasTickets ? 'Include this day when booking' : 'No tickets to log this day'}
                onChange={(e) => setCheckedDays((p) => ({ ...p, [day.date]: e.target.checked }))}
              />
              <span className="day-date">{fmtDate(day.date)}</span>
              <label className="wl-total">
                Day total
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={total}
                  disabled={!checked}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    setDayTotals((p) => ({ ...p, [day.date]: isNaN(v) ? 0 : v }))
                    setPrepared(false)
                  }}
                  onBlur={() =>
                    setDayTotals((p) => ({ ...p, [day.date]: snapToStep(p[day.date] ?? 0) }))
                  }
                />
                h
              </label>
              {day.settledToTs > 0 && (
                <span
                  className="wl-settled"
                  title={`Booked as ${fmtHours(day.settledHours)} — that stretch of the day is done`}
                >
                  settled {fmtClock(day.settledFromTs)}–{fmtClock(day.settledToTs)}
                </span>
              )}
              <span className="wl-meta">
                <span title={`${fmtHours(day.totalHours)} summed per ticket`}>
                  work {fmtHours(day.workHours)}
                </span>
                {span > 0 && ` · span ${fmtHours(span)}`}
                {dayBooked > 0 && (
                  <span className="wl-booked-meta"> · booked {fmtHours(dayBooked)}</span>
                )}
              </span>
            </div>

            {hasTickets ? (
              rows.map((row) => {
                const key = bookedKey(day.date, row.ticket)
                const done = row.booked > 0 && row.toBook <= 0
                const result = results[key]
                return (
                  <div className={`wl-row ${done ? 'done' : ''}`} key={row.ticket}>
                    <span className="wl-ticket">
                      <span className="ticket">{row.ticket}</span>
                      {row.branches.length > 0 && (
                        <span className="bucket-branch" title={row.branches.join('\n')}>
                          {row.branches.join(', ')}
                        </span>
                      )}
                      <span className="wl-project">{row.project}</span>
                    </span>
                    <span
                      className="wl-actual-h"
                      title={
                        row.actual === row.tracked
                          ? 'Tracked hours'
                          : `Tracked after the settled window (${fmtHours(row.tracked)} all day)`
                      }
                    >
                      {fmtHours(row.actual)}
                    </span>
                    {row.booked > 0 && (
                      <span className="wl-booked" title="Already booked in Jira">
                        ✓ {fmtHours(row.booked)}
                      </span>
                    )}
                    <select
                      className="wl-activity"
                      value={getActivity(day.date, row.ticket)}
                      disabled={!checked}
                      onChange={(e) => {
                        setActivities((p) => ({
                          ...p,
                          [actKey(day.date, row.ticket)]: e.target.value as WorklogActivity
                        }))
                        setPrepared(false)
                      }}
                    >
                      {ACTIVITIES.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      className={`wl-tobook ${pins[key] !== undefined ? 'pinned' : ''}`}
                      min={0}
                      step={0.5}
                      value={row.toBook}
                      disabled={!checked || booking}
                      title="Hours to book now — edit to override the calculated split"
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setPins((p) => ({ ...p, [key]: isNaN(v) ? 0 : v }))
                        setPrepared(false)
                      }}
                      onBlur={() =>
                        setPins((p) =>
                          p[key] === undefined ? p : { ...p, [key]: snapToStep(p[key]) }
                        )
                      }
                    />
                    {result &&
                      (result.ok ? (
                        <span className="wl-badge" title="Booked">
                          ✓
                        </span>
                      ) : (
                        <span className="wl-badge fail" title={result.error}>
                          ✗
                        </span>
                      ))}
                  </div>
                )
              })
            ) : (
              <div className="wl-row wl-empty">No tickets to log this day.</div>
            )}

            {nonTicket.map((b) => (
              <div className="wl-row wl-nonticket" key={b.key}>
                <span className="wl-ticket">
                  {b.label}
                  <span className="wl-project">{b.project}</span>
                </span>
                <span className="wl-actual-h">{fmtHours(b.hours)}</span>
                <span className="wl-note">not loggable</span>
              </div>
            ))}
          </div>
        )
      })}

      <div className="wl-foot">
        <span className="wl-meta">
          {fmtHours(totalToBook)} across {daysToBook} day{daysToBook === 1 ? '' : 's'}
        </span>
        {jiraConnected ? (
          <button className="wl-prepare" onClick={bookNow} disabled={totalToBook <= 0 || booking}>
            {booking ? 'Booking…' : `Book ${fmtHours(totalToBook)} to Jira →`}
          </button>
        ) : (
          <button
            className={`wl-prepare ${prepared ? 'done' : ''}`}
            onClick={prepared ? finish : prepare}
            disabled={totalToBook <= 0}
          >
            {prepared ? 'Done' : 'Prepare worklog →'}
          </button>
        )}
      </div>
    </div>
  )
}
