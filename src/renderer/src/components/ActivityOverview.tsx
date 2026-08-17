import { useCallback, useEffect, useState } from 'react'
import { useModalOverlay } from '../modal-overlay'
import type {
  ActivityReport,
  BookedWorklog,
  JiraStatus,
  LoggedWorklog
} from '../../../shared/types'
import {
  dayBookedState,
  sumBookedByDate,
  sumBookedByKey,
  bookedKey
} from '../../../shared/worklog-booked'
import { WorklogPrepare } from './WorklogPrepare'

interface Props {
  onClose: () => void
  onFillPrompt: (text: string) => void
}

type Range = 'today' | '7d' | '30d'
type Mode = 'overview' | 'worklog'

const RANGE_DAYS: Record<Range, number> = { today: 1, '7d': 7, '30d': 30 }
const RANGE_LABEL: Record<Range, string> = {
  today: 'Today',
  '7d': 'Past 7 days',
  '30d': 'Past 30 days'
}

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const DEFAULT_EMAIL = 'r.coenen@mendrix.nl'

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

/** Inline email+token form shown while no Jira token is stored. */
function JiraConnectBar({
  onConnected
}: {
  onConnected: (s: JiraStatus) => void
}): React.JSX.Element {
  const [email, setEmail] = useState(DEFAULT_EMAIL)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = (): void => {
    if (!email.trim() || !token.trim() || busy) return
    setBusy(true)
    setError(null)
    window.claudeTerm.jiraConnect(email, token).then((r) => {
      setBusy(false)
      if (r.ok) onConnected({ connected: true, email: email.trim() })
      else setError(r.error ?? 'Could not connect')
    })
  }

  return (
    <div className="jira-connect">
      <div className="jira-connect-row">
        <span className="jira-connect-label">
          Connect Jira to see &amp; book hours directly (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              void window.claudeTerm.openExternal(TOKEN_URL)
            }}
          >
            create an API token
          </a>
          )
        </span>
      </div>
      <div className="jira-connect-row">
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && connect()}
        />
        <button onClick={connect} disabled={busy || !email.trim() || !token.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error && <div className="jira-connect-error">{error}</div>}
    </div>
  )
}

export function ActivityOverview({ onClose, onFillPrompt }: Props): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('overview')
  const [range, setRange] = useState<Range>('today')
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [logged, setLogged] = useState<LoggedWorklog[]>([])
  const [loading, setLoading] = useState(true)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [jira, setJira] = useState<JiraStatus | null>(null)
  const [booked, setBooked] = useState<BookedWorklog[] | null>(null)
  const [bookedErr, setBookedErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([
      window.claudeTerm.activityReport(RANGE_DAYS[range]),
      window.claudeTerm.worklogLogged()
    ]).then(([r, l]) => {
      if (live) {
        setReport(r)
        setLogged(l)
        setLoading(false)
      }
    })
    return () => {
      live = false
    }
  }, [range])

  useEffect(() => {
    void window.claudeTerm.jiraStatus().then(setJira)
  }, [])

  // What's already in Jira for this range; non-blocking (report renders first).
  const refreshBooked = useCallback((): void => {
    if (!jira?.connected) return
    window.claudeTerm.jiraBooked(RANGE_DAYS[range]).then((r) => {
      if (r.ok) {
        setBooked(r.booked)
        setBookedErr(null)
      } else {
        setBooked(null)
        setBookedErr(r.error)
      }
    })
  }, [jira?.connected, range])

  useEffect(() => refreshBooked(), [refreshBooked])

  const disconnect = (): void => {
    void window.claudeTerm.jiraDisconnect().then(() => {
      setJira({ connected: false })
      setBooked(null)
      setBookedErr(null)
    })
  }

  // Escape closes; overlay is modal so grab focus off the terminal.
  const panelRef = useModalOverlay<HTMLDivElement>(onClose)

  const maxHours = report?.totals.reduce((m, t) => Math.max(m, t.hours), 0) ?? 0
  const empty = !report || report.days.length === 0
  const bookedByDate = booked ? sumBookedByDate(booked) : null
  const bookedByKey = booked ? sumBookedByKey(booked) : null

  const dayBadge = (date: string, ticketTracked: number): React.JSX.Element | null => {
    if (!bookedByDate) return null
    const b = bookedByDate[date] ?? 0
    const state = dayBookedState(ticketTracked, b)
    if (state === 'full' && ticketTracked <= 0) return null
    if (state === 'none') return <span className="booked-badge none">not booked</span>
    return (
      <span className={`booked-badge ${state}`}>
        booked {fmtHours(b)}
        {state === 'partial' ? ' · partial' : ''}
      </span>
    )
  }

  return (
    <div className="activity-backdrop" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="activity-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="activity-head">
          <span className="activity-title">Activity hours</span>
          <div className="activity-mode">
            <button
              className={`mode-btn ${mode === 'overview' ? 'active' : ''}`}
              onClick={() => setMode('overview')}
            >
              Overview
            </button>
            <button
              className={`mode-btn ${mode === 'worklog' ? 'active' : ''}`}
              onClick={() => setMode('worklog')}
            >
              Log hours
            </button>
          </div>
          <button className="activity-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="activity-subhead">
          <div className="activity-range">
            {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
              <button
                key={r}
                className={`range-btn ${range === r ? 'active' : ''}`}
                onClick={() => {
                  // reset here rather than in the fetch effect: same result,
                  // without a setState cascade on every range render
                  setLoading(true)
                  setSavedMsg(null)
                  setRange(r)
                }}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          {jira?.connected && (
            <span className="jira-status" title={jira.email}>
              Jira ✓
              <button
                className="jira-disconnect"
                onClick={disconnect}
                title={`Disconnect ${jira.email}`}
              >
                disconnect
              </button>
            </span>
          )}
        </div>

        <div className="activity-body">
          {jira !== null && !jira.connected && <JiraConnectBar onConnected={setJira} />}
          {bookedErr && <div className="jira-connect-error">Jira: {bookedErr}</div>}

          {loading ? (
            <p className="activity-empty">Loading…</p>
          ) : empty ? (
            <p className="activity-empty">No tracked activity in this range yet.</p>
          ) : mode === 'worklog' ? (
            <>
              {savedMsg && <div className="wl-saved">{savedMsg}</div>}
              <WorklogPrepare
                report={report!}
                logged={logged}
                booked={booked}
                jiraConnected={jira?.connected ?? false}
                onRefreshBooked={refreshBooked}
                onFillPrompt={onFillPrompt}
                onClose={onClose}
                onMessage={setSavedMsg}
              />
            </>
          ) : (
            <>
              <div className="activity-summary">
                <span className="activity-total">{fmtHours(report!.totalHours)}</span>
                <span className="activity-dim">total · {RANGE_LABEL[range].toLowerCase()}</span>
              </div>

              {report!.totals.length > 1 && (
                <div className="activity-totals">
                  {report!.totals.map((t) => (
                    <div className="totals-row" key={t.key}>
                      <span className="totals-label">
                        {t.ticket ? <span className="ticket">{t.ticket}</span> : t.label}
                        {t.ticket && t.branches.length > 0 && (
                          <span className="bucket-branch" title={t.branches.join('\n')}>
                            {t.branches.join(', ')}
                          </span>
                        )}
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
                {report!.days.map((day) => {
                  const ticketTracked = day.buckets
                    .filter((b) => b.ticket)
                    .reduce((s, b) => s + b.hours, 0)
                  return (
                    <div className="day-block" key={day.date}>
                      <div className="day-head">
                        <span className="day-date">{fmtDate(day.date)}</span>
                        {dayBadge(day.date, ticketTracked)}
                        <span className="day-total">{fmtHours(day.totalHours)}</span>
                      </div>
                      {day.buckets.map((b) => (
                        <div className="day-row" key={b.key}>
                          <span className="day-label">
                            {b.ticket ? <span className="ticket">{b.ticket}</span> : b.label}
                            {b.ticket && b.branches.length > 0 && (
                              <span className="bucket-branch" title={b.branches.join('\n')}>
                                {b.branches.join(', ')}
                              </span>
                            )}
                            <span className="day-project">{b.project}</span>
                          </span>
                          {b.ticket && bookedByKey && bookedByKey[bookedKey(day.date, b.ticket)] ? (
                            <span className="day-booked" title="Already booked in Jira">
                              ✓ {fmtHours(bookedByKey[bookedKey(day.date, b.ticket)])}
                            </span>
                          ) : null}
                          <span className="day-hours">{fmtHours(b.hours)}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
