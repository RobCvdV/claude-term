import { useEffect, useState } from 'react'
import type { ActivityReport } from '../../../shared/types'

interface Props {
  onClose: () => void
}

type Range = 'today' | '7d' | '30d'

const RANGE_DAYS: Record<Range, number> = { today: 1, '7d': 7, '30d': 30 }
const RANGE_LABEL: Record<Range, string> = { today: 'Today', '7d': 'Past 7 days', '30d': 'Past 30 days' }

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
  // iso is a local YYYY-MM-DD; parse as local (not UTC) to keep the day stable.
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function ActivityOverview({ onClose }: Props): React.JSX.Element {
  const [range, setRange] = useState<Range>('today')
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    window.claudeTerm.activityReport(RANGE_DAYS[range]).then((r) => {
      if (live) {
        setReport(r)
        setLoading(false)
      }
    })
    return () => {
      live = false
    }
  }, [range])

  // Escape closes; overlay is modal so grab focus off the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const maxHours = report?.totals.reduce((m, t) => Math.max(m, t.hours), 0) ?? 0

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div className="activity-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <span className="activity-title">Activity hours</span>
          <div className="activity-range">
            {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
              <button
                key={r}
                className={`range-btn ${range === r ? 'active' : ''}`}
                onClick={() => setRange(r)}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          <button className="activity-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="activity-body">
          {loading ? (
            <p className="activity-empty">Loading…</p>
          ) : !report || report.days.length === 0 ? (
            <p className="activity-empty">No tracked activity in this range yet.</p>
          ) : (
            <>
              <div className="activity-summary">
                <span className="activity-total">{fmtHours(report.totalHours)}</span>
                <span className="activity-dim">total · {RANGE_LABEL[range].toLowerCase()}</span>
              </div>

              {report.totals.length > 1 && (
                <div className="activity-totals">
                  {report.totals.map((t) => (
                    <div className="totals-row" key={t.key}>
                      <span className="totals-label">
                        {t.ticket ? <span className="ticket">{t.ticket}</span> : t.label}
                        <span className="totals-project">{t.project}</span>
                      </span>
                      <span className="totals-bar">
                        <span
                          className="totals-bar-fill"
                          style={{ width: `${maxHours ? (t.hours / maxHours) * 100 : 0}%` }}
                        />
                      </span>
                      <span className="totals-hours">{fmtHours(t.hours)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="activity-days">
                {report.days.map((day) => (
                  <div className="day-block" key={day.date}>
                    <div className="day-head">
                      <span className="day-date">{fmtDate(day.date)}</span>
                      <span className="day-total">{fmtHours(day.totalHours)}</span>
                    </div>
                    {day.buckets.map((b) => (
                      <div className="day-row" key={b.key}>
                        <span className="day-label">
                          {b.ticket ? <span className="ticket">{b.ticket}</span> : b.label}
                          <span className="day-project">{b.project}</span>
                        </span>
                        <span className="day-hours">{fmtHours(b.hours)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
