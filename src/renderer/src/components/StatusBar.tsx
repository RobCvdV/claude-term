import { useEffect, useRef, useState } from 'react'
import type { DocGroup, ProjectDocs, TabStatus } from '../../../shared/types'
import {
  actionsUrl,
  branchUrl,
  circleCiUrl,
  parseRemote,
  releasesUrl
} from '../../../shared/repo-links'
import { VolumeControl } from './VolumeControl'
import { statusFolders, type FolderChip } from '../status-folders'

interface Props {
  status: TabStatus | null
  color?: string
  /** open the docs overlay focused on the clicked section */
  onOpenDocs: (group: DocGroup) => void
  /** open the settings window (project configuration files) */
  onOpenSettings: () => void
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

/** Home folder + a "(+N)" badge; hovering/clicking the badge drops down the
 *  extra folders. Every entry opens in Finder. The dropdown is fixed-positioned
 *  because the status bar clips overflow. */
function FolderMenu({
  home,
  others
}: {
  home: FolderChip
  others: FolderChip[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, bottom: 0 })
  const anchor = useRef<HTMLSpanElement>(null)

  const show = (): void => {
    const r = anchor.current?.getBoundingClientRect()
    // bottom edge flush with the chip's top, so the pointer never leaves the
    // hover area on its way up into the list
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top })
    setOpen(true)
  }

  return (
    <span
      ref={anchor}
      className="folder-menu"
      onMouseEnter={others.length > 0 ? show : undefined}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        className="folder folder-open"
        title={home.path}
        onClick={() => window.claudeTerm.openFolder(home.path)}
      >
        {home.name}
      </span>
      {others.length > 0 && (
        <span className="folder-more" onClick={() => (open ? setOpen(false) : show())}>
          (+{others.length})
        </span>
      )}
      {open && others.length > 0 && (
        <div className="folder-dropdown" style={{ left: pos.left, bottom: pos.bottom }}>
          {others.map((f) => (
            <button
              key={f.path}
              title={f.path}
              onClick={() => {
                window.claudeTerm.openFolder(f.path)
                setOpen(false)
              }}
            >
              {f.name}
            </button>
          ))}
        </div>
      )}
    </span>
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

export function StatusBar({ status, color, onOpenDocs, onOpenSettings }: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const payload = status?.payload
  const git = status?.git
  // The tab's folder is where it was created (status.cwd — never re-homed).
  // Every other place the session works in — a /cd move, added dirs — folds
  // into the "(+N)" dropdown (see status-folders).
  const cwd = status?.cwd
  const { home, others } = statusFolders(status)
  const folder = home?.name

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

  // branch display with MTX ticket highlight + Bitbucket/GitHub link
  const repo = git?.remoteUrl ? parseRemote(git.remoteUrl) : null
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
    branchEl = repo ? (
      <ExternalLink url={branchUrl(repo, git.branch)} className="branch-link">
        {inner}
      </ExternalLink>
    ) : (
      <span>{inner}</span>
    )
  }

  // CI / PR links for the current branch. The PR one only appears once the main
  // process has actually found an open PR (Bitbucket API / `gh`).
  const circleci = repo && git?.branch ? circleCiUrl(repo, git.branch) : null
  const actions = repo && git?.branch && git.hasWorkflows ? actionsUrl(repo, git.branch) : null
  const releases = repo ? releasesUrl(repo) : null

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
      {home && <FolderMenu home={home} others={others} />}
      {branchEl}
      {git && (
        <span className="git-stats">
          {git.changed > 0 && <span className="stat-changed">~{git.changed}</span>}
          {git.unpushed > 0 && <span className="stat-ahead">↑{git.unpushed}</span>}
          {git.behind > 0 && <span className="stat-behind">↓{git.behind}</span>}
        </span>
      )}
      {payload?.cost &&
        (payload.cost.total_lines_added ?? 0) + (payload.cost.total_lines_removed ?? 0) > 0 && (
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
      {docs && docs.sections.length > 0 && (
        <button className="doc-link" onClick={() => onOpenDocs('docs')} title="Project docs">
          docs {docs.sections.reduce((n, s) => n + s.entries.length, 0)}
        </button>
      )}
      {/* No count here, unlike docs: listing config files stats every match, and
          this re-renders on every status update. */}
      <button
        className="doc-link"
        onClick={onOpenSettings}
        title="Configuration &amp; settings files for this project"
      >
        settings
      </button>
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
      {circleci && (
        <ExternalLink url={circleci} className="ext-link">
          CircleCI
        </ExternalLink>
      )}
      {git?.prUrl && (
        <ExternalLink url={git.prUrl} className="ext-link">
          PR
        </ExternalLink>
      )}
      {actions && (
        <ExternalLink url={actions} className="ext-link">
          Actions
        </ExternalLink>
      )}
      {releases && (
        <ExternalLink url={releases} className="ext-link">
          Releases
        </ExternalLink>
      )}
      <VolumeControl />
      <span className="clock">
        {new Date(now).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  )
}
