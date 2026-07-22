import { useEffect, useState } from 'react'
import type { DocGroup, ProjectDocs, TabStatus } from '../../../shared/types'
import { VolumeControl } from './VolumeControl'

interface Props {
  status: TabStatus | null
  color?: string
  /** open the docs overlay focused on the clicked section */
  onOpenDocs: (group: DocGroup) => void
}

const TICKET_RE = /^([^/]*\/)?([A-Z]+-[0-9]+)(-.*)?$/

/** Colour class for a rate-limit percentage: dim <40, white ≥40, orange ≥60,
 *  red ≥80. `active=false` keeps it dim regardless (used to hold the weekly
 *  window quiet until its last 2 days). */
function limitClass(pct: number | undefined, active = true): string {
  if (pct == null || !active) return 'dim'
  if (pct >= 80) return 'rl-red'
  if (pct >= 60) return 'rl-orange'
  if (pct >= 40) return 'rl-white'
  return 'dim'
}

function ExternalLink({
  url,
  children,
  className
}: {
  url: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <a
      href={url}
      className={className}
      onClick={(e) => {
        e.preventDefault()
        window.open(url)
      }}
    >
      {children}
    </a>
  )
}

function fmtCountdown(resetsAt: number, now: number): string {
  const secs = Math.max(0, Math.floor(resetsAt - now / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`
}

function fmtElapsed(sinceMs: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - sinceMs) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`
}

export function StatusBar({ status, color, onOpenDocs }: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const payload = status?.payload
  const git = status?.git
  const cwd = payload?.workspace?.current_dir ?? payload?.cwd
  const folder = cwd ? cwd.split('/').filter(Boolean).pop() : undefined

  // plan/roadmap/docs available for this tab's project — drives the labels below.
  // Re-fetched on activity changes too, so a plan or docs written mid-session
  // (a turn ends → activity flips) show up without needing a tab switch.
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const tabId = status?.tabId
  const activityKey = status?.activity
  useEffect(() => {
    if (!tabId) return
    let live = true
    window.claudeTerm.listDocs(tabId).then((d) => {
      if (live) setDocs(d)
    })
    return () => {
      live = false
    }
  }, [tabId, cwd, activityKey])

  // branch display with MTX ticket highlight + Bitbucket link
  let branchEl: React.JSX.Element | null = null
  let ticket: string | null = null
  if (git?.branch) {
    const match = TICKET_RE.exec(git.branch)
    let inner: React.ReactNode = <span className="dim">{git.branch}</span>
    if (match) {
      ticket = match[2]
      inner = (
        <>
          <span className="dim">{match[1] ?? ''}</span>
          <span className="ticket">{match[2]}</span>
          <span className="branch-desc">{match[3] ?? ''}</span>
        </>
      )
    }
    const bb = /bitbucket\.org[:/]([^/]+)\/([^/.]+)/.exec(git.remoteUrl)
    const gh = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(git.remoteUrl)
    const branchUrl = bb
      ? `https://bitbucket.org/${bb[1]}/${bb[2]}/branch/${encodeURIComponent(git.branch)}`
      : gh
        ? `https://github.com/${gh[1]}/${gh[2]}/tree/${encodeURIComponent(git.branch)}`
        : null
    branchEl = branchUrl ? (
      <ExternalLink url={branchUrl} className="branch-link">
        {inner}
      </ExternalLink>
    ) : (
      <span>{inner}</span>
    )
  }

  const usedPct = payload?.context_window?.used_percentage
  const ctxClass =
    usedPct == null ? '' : usedPct >= 78 ? 'ctx-red' : usedPct >= 60 ? 'ctx-orange' : ''

  const activity = status?.activity ?? 'starting'
  const activityEl =
    activity === 'busy' ? (
      <span className="activity busy">
        ● working{status?.busySince ? ` ${fmtElapsed(status.busySince, now)}` : ''}
      </span>
    ) : activity === 'needs-attention' ? (
      <span className="activity attention">● needs input</span>
    ) : activity === 'exited' || activity === 'ended' ? (
      <span className="activity exited">● {activity}</span>
    ) : activity === 'starting' ? (
      <span className="activity dim">● starting…</span>
    ) : (
      <span className="activity idle">● idle</span>
    )

  const jenkins =
    folder?.startsWith('mendrix-tms') && git?.branch
      ? `https://ci.mendrix.nl/job/${git.branch.startsWith('feature/') ? 'FeatureBuild' : 'BugfixBuild'}/job/${encodeURIComponent(git.branch.replace(/\//g, '%2F'))}/`
      : null

  const rl5 = payload?.rate_limits?.five_hour
  const rl7 = payload?.rate_limits?.seven_day
  // Colour the weekly window only in its last 2 days (before reset); stay dim
  // otherwise so normal weekly burn doesn't read as alarming.
  const rl7Near = rl7?.resets_at != null && rl7.resets_at - now / 1000 <= 2 * 24 * 3600

  // Session cost is only meaningful when paying per token. We can't tell
  // subscription-vs-API from the statusline payload, so fall back to: show cost
  // only for non-Claude models (e.g. DeepSeek), which are always API-metered.
  const modelTag = (payload?.model?.id || payload?.model?.display_name || '').toLowerCase()
  const externalModel = modelTag.length > 0 && !modelTag.includes('claude')
  const showCost = externalModel && payload?.cost?.total_cost_usd != null

  return (
    <div className="status-bar" style={color ? { borderTopColor: color } : undefined}>
      {activityEl}
      {folder && <span className="folder">{folder}</span>}
      {branchEl}
      {git && (
        <span className="git-stats">
          {git.changed > 0 && <span className="stat-changed">~{git.changed}</span>}
          {git.unpushed > 0 && <span className="stat-ahead">↑{git.unpushed}</span>}
          {git.behind > 0 && <span className="stat-behind">↓{git.behind}</span>}
        </span>
      )}
      {payload?.cost && (payload.cost.total_lines_added ?? 0) + (payload.cost.total_lines_removed ?? 0) > 0 && (
        <span className="dim">
          +{payload.cost.total_lines_added ?? 0}/−{payload.cost.total_lines_removed ?? 0}
        </span>
      )}
      {payload?.model?.display_name && (
        <span className="model">
          {payload.model.display_name}
          {payload.effort?.level ? ` (${payload.effort.level})` : ''}
        </span>
      )}
      {usedPct != null && <span className={`ctx ${ctxClass}`}>{usedPct}%</span>}
      {showCost && <span className="dim">${payload!.cost!.total_cost_usd!.toFixed(2)}</span>}
      {rl5?.used_percentage != null && rl5.resets_at != null && (
        <span className={limitClass(rl5.used_percentage)} title="5-hour rate limit window">
          5h {Math.round(rl5.used_percentage)}% ({fmtCountdown(rl5.resets_at, now)})
        </span>
      )}
      {rl7?.used_percentage != null && (
        <span className={limitClass(rl7.used_percentage, rl7Near)} title="7-day rate limit window">
          7d {Math.round(rl7.used_percentage)}%
        </span>
      )}
      <span className="spacer" />
      {docs && docs.plans.length > 0 && (
        <button
          className="doc-link"
          onClick={() => onOpenDocs('plan')}
          title="Plan-mode plans for this project"
        >
          plan
        </button>
      )}
      {docs?.roadmap && (
        <button className="doc-link" onClick={() => onOpenDocs('roadmap')} title="Project roadmap">
          roadmap
        </button>
      )}
      {docs && docs.docs.length > 0 && (
        <button className="doc-link" onClick={() => onOpenDocs('docs')} title="Project docs">
          docs {docs.docs.length}
        </button>
      )}
      {ticket && (
        <ExternalLink url={`https://mendrix.atlassian.net/browse/${ticket}`} className="ext-link">
          Jira
        </ExternalLink>
      )}
      {jenkins && (
        <ExternalLink url={jenkins} className="ext-link">
          Jenkins
        </ExternalLink>
      )}
      <VolumeControl />
      <span className="clock">
        {new Date(now).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  )
}
