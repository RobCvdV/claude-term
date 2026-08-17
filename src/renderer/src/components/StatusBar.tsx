import { Fragment, useEffect, useRef, useState } from 'react'
import type {
  BranchGroup,
  CiInfo,
  CiProvider,
  DocGroup,
  PrGroup,
  ProjectDocs,
  RateForecast,
  RepoStatus,
  TabId,
  TabStatus,
  WindowForecast
} from '../../../shared/types'
import {
  actionsUrl,
  branchUrl,
  circleCiUrl,
  jenkinsJobUrl,
  parseRemote,
  releasesUrl
} from '../../../shared/repo-links'
import { VolumeControl } from './VolumeControl'
import { nameOf, statusFolders, type FolderChip } from '../../../shared/status-folders'

interface Props {
  status: TabStatus | null
  color?: string
  /** open the file window, landing on the group that was clicked */
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
  className,
  title
}: {
  url: string
  children: React.ReactNode
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <a
      href={url}
      className={className}
      title={title}
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
 *  extra folders. Every entry opens in Finder; right-click shows the open-in
 *  menu. The dropdown is fixed-positioned because the status bar clips
 *  overflow. */
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
        onContextMenu={(e) => {
          e.preventDefault()
          window.claudeTerm.folderContextMenu(home.path)
        }}
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
              onContextMenu={(e) => {
                e.preventDefault()
                setOpen(false)
                window.claudeTerm.folderContextMenu(f.path)
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

/** Marks a row as the user's own — their PR, or a branch whose newest commit is
 *  theirs. Kept to a word: in a list of ten, "which of these are mine" is the
 *  question being asked. */
function Mine(): React.JSX.Element {
  return (
    <span className="pr-mine" title="yours">
      mine
    </span>
  )
}

/** A branch name with the ticket number highlighted, for the branch menu. */
function BranchLabel({ branch }: { branch: string }): React.JSX.Element {
  const m = TICKET_RE.exec(branch)
  if (!m) return <span className="pr-title">{branch}</span>
  return (
    <span className="pr-title">
      <span className="dim">{m[1] ?? ''}</span>
      <span className="ticket">{m[2]}</span>
      {m[3] ?? ''}
    </span>
  )
}

// 7: the magic/biblical super number — enough recall, no wall of branches
const BRANCHES_SHOWN = 7

/** The branch chip + dropdown of every workspace repo's local branches
 *  (most-recently-committed first, grouped under folder names with several
 *  repos). Click an entry to `git switch` that repo there — the session gets
 *  the same "branch switched" FYI as /switch; right-click opens the branch on
 *  Bitbucket/GitHub. Fetched lazily on open, like the PR menu. */
function BranchMenu({
  tabId,
  cwd,
  chip,
  remoteByRoot
}: {
  tabId: TabId
  cwd: string
  chip: React.ReactNode
  remoteByRoot: Map<string, string>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<BranchGroup[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pos, setPos] = useState({ left: 0, bottom: 0 })
  const anchor = useRef<HTMLSpanElement>(null)

  const show = (): void => {
    const r = anchor.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top })
    setOpen(true)
    setErr(null)
    void window.claudeTerm.listWorkspaceBranches(tabId).then(setGroups)
  }

  const pick = async (root: string, branch: string): Promise<void> => {
    if (busy) return
    setBusy(branch)
    setErr(null)
    const res = await window.claudeTerm.switchBranch(tabId, branch, root)
    setBusy(null)
    if (!res.ok) {
      setErr(res.error || 'git switch failed')
      return
    }
    setOpen(false)
    // notify only (no /clear): let claude know its file view may be stale
    const where = root === cwd ? 'this repo' : `the repo at ${root}`
    window.claudeTerm.submitPrompt(
      tabId,
      `FYI: I switched ${where} to branch \`${branch}\`. Files you read earlier may have changed — re-read before editing.`,
      0
    )
  }

  const openRemote = (root: string, branch: string): void => {
    const remote = remoteByRoot.get(root)
    const repo = remote ? parseRemote(remote) : null
    if (repo) window.open(branchUrl(repo, branch))
  }

  const multi = (groups?.length ?? 0) > 1
  return (
    <span
      ref={anchor}
      className="branch-menu"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
    >
      {chip}
      {open && (
        <div className="pr-dropdown branch-dropdown" style={{ left: pos.left, bottom: pos.bottom }}>
          {err && <div className="pr-note branch-error">{err}</div>}
          {groups === null ? (
            <div className="pr-note">loading…</div>
          ) : groups.length === 0 ? (
            <div className="pr-note">no git repos</div>
          ) : (
            groups.map((g) => (
              <Fragment key={g.root}>
                {multi && (
                  <div className="pr-group" title={g.root}>
                    {nameOf(g.root)}
                  </div>
                )}
                {g.current && (
                  <button
                    className="pr-current"
                    title={`${g.current} — checked out in ${g.root}`}
                    onClick={() => setOpen(false)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openRemote(g.root, g.current!)
                    }}
                  >
                    <BranchLabel branch={g.current} />
                  </button>
                )}
                {g.branches.length === 0 && <div className="pr-note">no other branches</div>}
                {g.branches.slice(0, BRANCHES_SHOWN).map((b) => (
                  <button
                    key={b.name}
                    className={busy === b.name ? 'branch-busy' : undefined}
                    title={
                      `switch ${g.root} to ${b.name}` +
                      (b.mine ? ' — your own newest commit' : '') +
                      ' — right-click opens it on the remote'
                    }
                    onClick={() => void pick(g.root, b.name)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openRemote(g.root, b.name)
                    }}
                  >
                    <BranchLabel branch={b.name} />
                    {b.mine && <Mine />}
                  </button>
                ))}
                {g.branches.length > BRANCHES_SHOWN && (
                  <div className="pr-note">
                    +{g.branches.length - BRANCHES_SHOWN} more (/switch)
                  </div>
                )}
              </Fragment>
            ))
          )}
        </div>
      )}
    </span>
  )
}

/** "PRs" link + dropdown of every workspace repo's open PRs (most recent 10
 *  each). With several repos the entries are grouped under small folder-name
 *  titles. Click an entry to open it in the browser; right-click for
 *  Open/Merge. Fetched lazily on open, served from a main-process cache.
 *  Fixed-positioned like the folder dropdown because the status bar clips
 *  overflow. */
function PrMenu({
  tabId,
  prUrlByRoot
}: {
  tabId: TabId
  prUrlByRoot: Map<string, string | null>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<PrGroup[] | null>(null)
  const [pos, setPos] = useState({ right: 0, bottom: 0 })
  const anchor = useRef<HTMLSpanElement>(null)

  const show = (): void => {
    const r = anchor.current?.getBoundingClientRect()
    if (r) setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top })
    setOpen(true)
    void window.claudeTerm.listPrs(tabId).then(setGroups)
  }

  const multi = (groups?.length ?? 0) > 1
  return (
    <span ref={anchor} className="pr-menu" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <span className="ext-link" onClick={() => (open ? setOpen(false) : show())}>
        PRs
      </span>
      {open && (
        <div className="pr-dropdown" style={{ right: pos.right, bottom: pos.bottom }}>
          {groups === null ? (
            <div className="pr-note">loading…</div>
          ) : groups.length === 0 || groups.every((g) => g.prs.length === 0) ? (
            <div className="pr-note">no open PRs</div>
          ) : (
            groups.map((g) => (
              <Fragment key={g.root}>
                {multi && (
                  <div className="pr-group" title={g.root}>
                    {nameOf(g.root)}
                  </div>
                )}
                {multi && g.prs.length === 0 && <div className="pr-note">no open PRs</div>}
                {g.prs.map((pr) => (
                  <button
                    key={pr.url}
                    className={pr.url === prUrlByRoot.get(g.root) ? 'pr-current' : undefined}
                    title={pr.title}
                    onClick={() => {
                      window.open(pr.url)
                      setOpen(false)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setOpen(false)
                      window.claudeTerm.prContextMenu(tabId, pr, g.root)
                    }}
                  >
                    <span className="pr-number">#{pr.number}</span>
                    <span className="pr-title">{pr.title}</span>
                    {pr.mine && <Mine />}
                  </button>
                ))}
              </Fragment>
            ))
          )}
        </div>
      )}
    </span>
  )
}

/** The one CI link an extra workspace repo gets, mirroring the poller's
 *  provider priority (jenkins → actions → circleci). */
function extraCiLink(r: RepoStatus): { url: string; provider: CiProvider; label: string } | null {
  const branch = r.git.branch
  if (!branch) return null
  const jenkins = jenkinsJobUrl(r.root.split('/').filter(Boolean).pop() ?? '', branch)
  if (jenkins) return { url: jenkins, provider: 'jenkins', label: 'Jenkins' }
  const repo = r.git.remoteUrl ? parseRemote(r.git.remoteUrl) : null
  const actions = repo && r.git.hasWorkflows ? actionsUrl(repo, branch) : null
  if (actions) return { url: actions, provider: 'actions', label: 'Actions' }
  const circle = repo ? circleCiUrl(repo, branch) : null
  if (circle) return { url: circle, provider: 'circleci', label: 'CircleCI' }
  return null
}

/** Live-CI dot shown inside a CI link when the poller knows this provider. */
function CiDot({ ci, provider }: { ci: CiInfo | null; provider: CiProvider }): React.ReactNode {
  if (!ci || ci.provider !== provider) return null
  return <span className={`ci-dot ci-${ci.state}`}>●</span>
}

/** "~14:32" within a day, "~Wed 14:32" beyond. */
function fmtEta(hitsAtSec: number, now: number): string {
  const d = new Date(hitsAtSec * 1000)
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
  if (hitsAtSec * 1000 - now < 22 * 3600 * 1000) return `~${time}`
  return `~${d.toLocaleDateString('en', { weekday: 'short' })} ${time}`
}

/** Tooltip suffix for a rate-limit window's burn forecast. */
function forecastNote(f: WindowForecast | undefined, now: number): string {
  if (!f?.hitsAt) return ''
  return ` — at this pace 100% ${fmtEta(f.hitsAt, now)}${f.beforeReset ? ', before reset' : ''}`
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
  // The tab's folder is where it was created (status.cwd — never re-homed).
  // Every other place the session works in — a /cd move, added dirs — folds
  // into the "(+N)" dropdown (see status-folders).
  const cwd = status?.cwd
  const { home, others } = statusFolders(status)

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

  const jenkins = cwd && git?.branch ? jenkinsJobUrl(cwd.split('/').pop() ?? '', git.branch) : null
  const ci = status?.ci ?? null
  const extraRepos = status?.extraRepos ?? []
  // current-branch PR per workspace repo, for the dropdown's bold highlight
  const prUrlByRoot = new Map<string, string | null>([
    ...(cwd ? [[cwd, git?.prUrl ?? null] as const] : []),
    ...extraRepos.map((r) => [r.root, r.git.prUrl] as const)
  ])
  // remote per workspace repo, for the branch menu's right-click open
  const remoteByRoot = new Map<string, string>([
    ...(cwd && git?.remoteUrl ? [[cwd, git.remoteUrl] as const] : []),
    ...extraRepos.filter((r) => r.git.remoteUrl).map((r) => [r.root, r.git.remoteUrl] as const)
  ])

  const rl5 = payload?.rate_limits?.five_hour
  const rl7 = payload?.rate_limits?.seven_day
  // Colour the weekly window only in its last 2 days (before reset); stay dim
  // otherwise so normal weekly burn doesn't read as alarming.
  const rl7Near = rl7?.resets_at != null && rl7.resets_at - now / 1000 <= 2 * 24 * 3600

  // burn forecast for the tooltips; refreshed when the used percentages move
  const [forecast, setForecast] = useState<RateForecast | null>(null)
  const pct5 = rl5?.used_percentage
  const pct7 = rl7?.used_percentage
  useEffect(() => {
    if (pct5 == null && pct7 == null) return
    let live = true
    void window.claudeTerm.rateForecast().then((f) => {
      if (live) setForecast(f)
    })
    return () => {
      live = false
    }
  }, [pct5, pct7])
  // projected to hit 100% before its reset → turn orange early (red still wins)
  const warn5 = forecast?.fiveHour.beforeReset && (pct5 ?? 0) < 80
  const warn7 = forecast?.sevenDay.beforeReset && (pct7 ?? 0) < 80

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
      {branchEl &&
        (tabId && cwd ? (
          <BranchMenu tabId={tabId} cwd={cwd} chip={branchEl} remoteByRoot={remoteByRoot} />
        ) : (
          branchEl
        ))}
      {git && (
        <span className="git-stats">
          {/* the changed count is the way into the diff — it is what you are
              looking at when you want to know what just happened */}
          {git.changed > 0 && (
            <button
              className="stat-changed stat-link"
              onClick={() => onOpenDocs('diff')}
              title="Review what changed since the last commit"
            >
              ~{git.changed}
            </button>
          )}
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
        <span
          className={warn5 ? 'rl-orange' : limitClass(rl5.used_percentage)}
          title={`5-hour rate limit window${forecastNote(forecast?.fiveHour, now)}`}
        >
          5h {Math.round(rl5.used_percentage)}% ({fmtCountdown(rl5.resets_at, now)})
        </span>
      )}
      {rl7?.used_percentage != null && (
        <span
          className={warn7 ? 'rl-orange' : limitClass(rl7.used_percentage, rl7Near)}
          title={`7-day rate limit window${forecastNote(forecast?.sevenDay, now)}`}
        >
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
      {/* No count here, unlike docs: counting config files means stating every
          match, and this re-renders on every status update. */}
      <button
        className="doc-link"
        onClick={() => onOpenDocs('settings')}
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
        <ExternalLink
          url={jenkins}
          className="ext-link"
          title={ci?.provider === 'jenkins' ? `build: ${ci.state}` : undefined}
        >
          <CiDot ci={ci} provider="jenkins" />
          Jenkins
        </ExternalLink>
      )}
      {circleci && (
        <ExternalLink
          url={circleci}
          className="ext-link"
          title={ci?.provider === 'circleci' ? `pipeline: ${ci.state}` : undefined}
        >
          <CiDot ci={ci} provider="circleci" />
          CircleCI
        </ExternalLink>
      )}
      {(repo || extraRepos.length > 0) && tabId && (
        <PrMenu tabId={tabId} prUrlByRoot={prUrlByRoot} />
      )}
      {actions && (
        <ExternalLink
          url={actions}
          className="ext-link"
          title={ci?.provider === 'actions' ? `run: ${ci.state}` : undefined}
        >
          <CiDot ci={ci} provider="actions" />
          Actions
        </ExternalLink>
      )}
      {extraRepos.map((r) => {
        const link = extraCiLink(r)
        if (!link) return null
        return (
          <span key={r.root} className="repo-ci">
            <span className="repo-ci-name" title={r.root}>
              {nameOf(r.root)}
            </span>
            <ExternalLink
              url={link.url}
              className="ext-link"
              title={r.ci ? `build: ${r.ci.state}` : undefined}
            >
              <CiDot ci={r.ci} provider={link.provider} />
              {link.label}
            </ExternalLink>
          </span>
        )
      })}
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
