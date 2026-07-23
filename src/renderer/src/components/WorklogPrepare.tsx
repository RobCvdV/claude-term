import { useEffect, useMemo, useState } from 'react'
import type { ActivityReport, LoggedWorklog, WorklogActivity, WorklogPlanEntry } from '../../../shared/types'
import { dispatchHours, snapToStep } from '../../../shared/worklog'

interface Props {
  report: ActivityReport
  logged: LoggedWorklog[]
  onSaved: (count: number) => void
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

export function WorklogPrepare({ report, logged, onSaved, onFillPrompt, onClose }: Props): React.JSX.Element {
  const [dayTotals, setDayTotals] = useState<Record<string, number>>({})
  const [activities, setActivities] = useState<Record<string, WorklogActivity>>({})
  // true once the current split has been written to the plan file; any edit
  // (or a range change) invalidates it back to false.
  const [prepared, setPrepared] = useState(false)

  // Reset the editable totals to the per-day suggestion whenever the report
  // (i.e. the range) changes.
  useEffect(() => {
    const init: Record<string, number> = {}
    for (const d of report.days) init[d.date] = d.suggestedHours
    setDayTotals(init)
    setActivities({})
    setPrepared(false)
  }, [report])

  const loggedSet = useMemo(
    () => new Set(logged.map((l) => `${l.date}|${l.issueKey}`)),
    [logged]
  )

  const actKey = (date: string, ticket: string): string => `${date}|${ticket}`
  const getActivity = (date: string, ticket: string): WorklogActivity =>
    activities[actKey(date, ticket)] ?? 'coding'

  /** Ticket buckets of a day, with their live-dispatched hours. */
  const dispatchFor = (date: string): { ticket: string; project: string; actual: number; hours: number }[] => {
    const day = report.days.find((d) => d.date === date)
    if (!day) return []
    const tickets = day.buckets.filter((b) => b.ticket)
    const total = dayTotals[date] ?? day.suggestedHours
    const split = dispatchHours(total, tickets.map((b) => ({ id: b.key, actual: b.hours })))
    const byId = new Map(split.map((s) => [s.id, s.hours]))
    return tickets.map((b) => ({
      ticket: b.ticket as string,
      project: b.project,
      actual: b.hours,
      hours: byId.get(b.key) ?? 0
    }))
  }

  const buildEntries = (): WorklogPlanEntry[] => {
    const entries: WorklogPlanEntry[] = []
    for (const day of report.days) {
      for (const row of dispatchFor(day.date)) {
        if (row.hours <= 0) continue
        entries.push({
          date: day.date,
          issueKey: row.ticket,
          hours: row.hours,
          activity: getActivity(day.date, row.ticket)
        })
      }
    }
    return entries
  }

  // First press: write the plan file and flip the button to "Done".
  const prepare = (): void => {
    const entries = buildEntries()
    window.claudeTerm.saveWorklogPlan({ generatedAt: Date.now(), entries }).then(() => {
      setPrepared(true)
      onSaved(entries.length)
    })
  }

  // Second press ("Done"): tee up the follow-up prompt and close the panel so
  // it's sitting in the box ready to send to Claude. The prompt points Claude
  // straight at the plan we just wrote so it posts those entries instead of
  // re-deriving the activity from scratch.
  const finish = (): void => {
    onFillPrompt(
      'Log my hours — post the prepared worklog at ~/.claude/activity-worklog-plan.json ' +
        'to Jira. Use those entries exactly as prepared; do not re-analyze my activity. ' +
        'Skip any already recorded in ~/.claude/activity-worklog-log.json.'
    )
    onClose()
  }

  const totalToLog = buildEntries().reduce((s, e) => s + e.hours, 0)

  return (
    <div className="wl">
      <div className="wl-intro">
        Review the split, then prepare it — the hours are handed to Claude to post to Jira.
      </div>

      {report.days.map((day) => {
        const rows = dispatchFor(day.date)
        const nonTicket = day.buckets.filter((b) => !b.ticket)
        const span = day.lastTs > day.firstTs ? (day.lastTs - day.firstTs) / 3600 : 0
        const total = dayTotals[day.date] ?? day.suggestedHours
        const hasTickets = rows.length > 0
        return (
          <div className="wl-day" key={day.date}>
            <div className="wl-day-head">
              <span className="day-date">{fmtDate(day.date)}</span>
              <label className="wl-total">
                Day total
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={total}
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
              <span className="wl-meta">
                tracked {fmtHours(day.totalHours)}
                {span > 0 && ` · span ${fmtHours(span)}`}
              </span>
            </div>

            {hasTickets ? (
              rows.map((row) => {
                const done = loggedSet.has(`${day.date}|${row.ticket}`)
                return (
                  <div className={`wl-row ${done ? 'done' : ''}`} key={row.ticket}>
                    <span className="wl-ticket">
                      <span className="ticket">{row.ticket}</span>
                      <span className="wl-project">{row.project}</span>
                    </span>
                    <span className="wl-actual-h">{fmtHours(row.actual)}</span>
                    <select
                      className="wl-activity"
                      value={getActivity(day.date, row.ticket)}
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
                    <span className="wl-dispatch">{fmtHours(row.hours)}</span>
                    {done && <span className="wl-badge" title="Already logged">✓</span>}
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
        <span className="wl-meta">{fmtHours(totalToLog)} across all days</span>
        <button
          className={`wl-prepare ${prepared ? 'done' : ''}`}
          onClick={prepared ? finish : prepare}
          disabled={totalToLog <= 0}
        >
          {prepared ? 'Done' : 'Prepare worklog →'}
        </button>
      </div>
    </div>
  )
}
