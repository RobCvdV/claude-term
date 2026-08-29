import { createServer, Server } from 'http'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  ActivityState,
  CiInfo,
  GitInfo,
  HookEvent,
  RepoStatus,
  StatuslinePayload,
  TabId,
  TabStatus
} from '../shared/types'
import { parseRemote } from '../shared/repo-links'
import { statusFolders } from '../shared/status-folders'
import { pullRequestUrl } from './pr-links'
import { sessionNameForBranch } from './session-name'
import { attachedActivity } from './attached-activity'
import { transcriptPathFor } from './session-home'
import { readJobState } from './agents'
import { settingsAddedDirs } from './project-dirs'

const GIT_CACHE_MS = 5_000
const GIT_TIMER_MS = 10_000
const ATTACH_TIMER_MS = 3_000

/** A tab hosting an attached background agent. Its hooks/statusline carry the
 *  --settings of the app run that launched it, so unless that endpoint still
 *  resolves here (see resolveTab) no live feed arrives — activity is then
 *  synthesized from the transcript file and the daemon's job state. */
interface AttachedFeed {
  sessionId: string
  jobId: string | null
  transcriptPath: string | null
  /** a real hook/statusline reached this tab — stop synthesizing */
  live: boolean
}

interface TabState {
  status: TabStatus
  cwd: string
  /** True while no claude session has claimed the tab's folder yet. The next
   *  session's launch dir becomes the tab's home (see adoptSessionHome); it is
   *  re-armed every time the tab drops back to a plain terminal. */
  homeUnclaimed: boolean
  gitFetchedAt: number
  /** Rename queued by a branch switch, waiting for the session to go idle so we
   *  don't inject `/rename` mid-turn. Null once applied. */
  pendingRename: string | null
  /** The last name we injected via `/rename`, to avoid re-sending the same one. */
  lastRenamedName: string | null
}

/**
 * One local HTTP server receives both feeds from inside each Claude Code
 * session: the statusline JSON (via the forwarder script) and hook events
 * (via "type":"http" hooks). It keeps the latest status per tab and derives
 * a busy/idle activity state, so the renderer can re-render at any time.
 */
export class StatusServer {
  readonly token: string
  private server: Server | null = null
  private tabs = new Map<TabId, TabState>()
  private attached = new Map<TabId, AttachedFeed>()
  private gitTimer: NodeJS.Timeout | null = null
  private attachTimer: NodeJS.Timeout | null = null

  /** The endpoint (port + token) is persisted so it survives app restarts:
   *  a background agent's --settings are baked at its launch and live as long
   *  as the agent — a fresh ephemeral port would orphan every running one. */
  constructor(private readonly endpointFile?: () => string) {
    this.token = this.loadEndpoint()?.token ?? randomBytes(16).toString('hex')
  }

  private loadEndpoint(): { port: number; token: string } | null {
    if (!this.endpointFile) return null
    try {
      const raw = JSON.parse(readFileSync(this.endpointFile(), 'utf8')) as {
        port?: unknown
        token?: unknown
      }
      if (typeof raw.port === 'number' && typeof raw.token === 'string' && raw.token) {
        return { port: raw.port, token: raw.token }
      }
    } catch {
      /* first run or corrupt file */
    }
    return null
  }
  /** Every session id that has POSTed to us this run (tabs + any background
   *  agents dispatched from a tab). Used at quit to find our daemon agents. */
  private seenSessions = new Set<string>()
  /** Set once the app is tearing down — see freeze(). */
  private frozen = false
  port = 0

  /** Set by ipc.ts; called whenever a tab's status changes. */
  onUpdate: (status: TabStatus) => void = () => {}

  /** Called when the session shows a dialog that wants keyboard input NOW
   *  (permission prompt, question picker) — not for idle notifications. */
  onAttention: (tabId: TabId, hookEvent: string) => void = () => {}

  /** Set by ipc.ts; feeds the branch-history store — fired for every branch
   *  seen checked out in a tab's workspace (own repo + extra repos). */
  onBranchSeen: (root: string, branch: string) => void = () => {}

  /** Set by ipc.ts; injects `/rename <name>` into the tab's live Claude session
   *  when the git branch changes, so the Claude app's session name tracks the
   *  branch (matching the launch-time `--name`). Only fired while idle. */
  onRenameSession: (tabId: TabId, name: string) => void = () => {}

  /** A turn just started in this tab (UserPromptSubmit) — the moment to take a
   *  working-tree checkpoint, before any edit of that turn lands. */
  onTurnStart: (tabId: TabId, cwd: string) => void = () => {}

  /** Set by ipc.ts; the tab adopted the folder its claude session was launched
   *  from (see adoptSessionHome), so the PTY's respawn dir has to follow. */
  onHomeChanged: (tabId: TabId, cwd: string) => void = () => {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const tabId = url.searchParams.get('tab')
      const token = url.searchParams.get('token')
      if (req.method !== 'POST' || token !== this.token || !tabId) {
        res.writeHead(403).end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return
        }
        const target = this.resolveTab(tabId, (body as { session_id?: string }).session_id)
        if (url.pathname === '/statusline') {
          this.handleStatusline(target, body as StatuslinePayload)
        } else if (url.pathname === '/hook') {
          this.handleHook(target, body as HookEvent)
        }
      })
    })
    const listen = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        this.server!.once('error', onError)
        this.server!.listen(port, '127.0.0.1', () => {
          this.server!.removeListener('error', onError)
          const addr = this.server!.address()
          resolve(addr && typeof addr === 'object' ? addr.port : 0)
        })
      })
    try {
      this.port = await listen(this.loadEndpoint()?.port ?? 0)
    } catch {
      // persisted port taken (another instance/process) — fall back, re-persist
      this.port = await listen(0)
    }
    if (this.endpointFile) {
      try {
        writeFileSync(this.endpointFile(), JSON.stringify({ port: this.port, token: this.token }))
      } catch {
        /* best effort */
      }
    }
    this.gitTimer = setInterval(() => this.refreshAllGit(), GIT_TIMER_MS)
    this.attachTimer = setInterval(() => this.pollAttached(), ATTACH_TIMER_MS)
  }

  /** A POST whose tab id is stale (an attached agent's overlay predates this
   *  app run) is re-routed to whichever current tab hosts that session. */
  private resolveTab(tabId: TabId, sessionId?: string): TabId {
    if (this.tabs.has(tabId) || !sessionId) return tabId
    for (const [id, tab] of this.tabs) {
      if (tab.status.sessionId === sessionId) return id
    }
    return tabId
  }

  /**
   * Stop accepting status changes: we're quitting, and what we hold right now is
   * exactly what has to reach session.json.
   *
   * Quitting kills every PTY, which makes each tab report its Claude session
   * gone (the PTY exit, plus the session's own SessionEnd hook on the way out).
   * Those updates reached the renderer *before* its final save, so a tab that
   * was mid-conversation persisted as `claudeActive: false` and the next launch
   * revived nothing — the tab came back as a plain terminal and then overwrote
   * its own session id with null, losing the conversation for good.
   *
   * Must be called before the PTYs are killed (see index.ts shutdown()).
   */
  freeze(): void {
    this.frozen = true
  }

  stop(): void {
    if (this.gitTimer) clearInterval(this.gitTimer)
    if (this.attachTimer) clearInterval(this.attachTimer)
    this.server?.close()
  }

  /** The tab hosts an attached background agent — synthesize its activity
   *  (transcript writes → busy, daemon `blocked` → needs-attention) until a
   *  real hook or statusline proves a live feed reaches us. */
  markAttached(tabId: TabId, sessionId: string, jobId: string | null): void {
    this.attached.set(tabId, {
      sessionId,
      jobId,
      transcriptPath: transcriptPathFor(sessionId),
      live: false
    })
  }

  private pollAttached(): void {
    if (this.frozen) return
    for (const [tabId, feed] of this.attached) {
      if (feed.live) continue
      const tab = this.tabs.get(tabId)
      if (!tab || !tab.status.claudeActive) continue
      feed.transcriptPath ??= transcriptPathFor(feed.sessionId)
      let mtime: number | null = null
      if (feed.transcriptPath) {
        try {
          mtime = statSync(feed.transcriptPath).mtimeMs
        } catch {
          feed.transcriptPath = null
        }
      }
      const next = attachedActivity({
        transcriptMtime: mtime,
        jobState: feed.jobId ? readJobState(feed.jobId) : null,
        now: Date.now()
      })
      const prev = tab.status.activity
      if (next === prev) continue
      tab.status.busySince = next === 'busy' ? Date.now() : null
      tab.status.activity = next
      this.onUpdate(tab.status)
      if (next === 'needs-attention') this.onAttention(tabId, 'AgentBlocked')
    }
  }

  registerTab(
    tabId: TabId,
    cwd: string,
    addedDirs: string[] = [],
    homeUnclaimed = true,
    removedDirs: string[] = []
  ): void {
    const removed = new Set(removedDirs)
    this.tabs.set(tabId, {
      cwd,
      homeUnclaimed,
      gitFetchedAt: 0,
      pendingRename: null,
      lastRenamedName: null,
      status: {
        tabId,
        claudeActive: false,
        activity: 'idle',
        busySince: null,
        sessionId: null,
        exitCode: null,
        cwd,
        addedDirs: addedDirs.filter((d) => !removed.has(d)),
        removedDirs,
        payload: null,
        git: null,
        ci: null,
        extraRepos: []
      }
    })
    void this.refreshGit(tabId)
  }

  removeTab(tabId: TabId): void {
    this.tabs.delete(tabId)
    this.attached.delete(tabId)
  }

  snapshot(tabId: TabId): TabStatus | null {
    return this.tabs.get(tabId)?.status ?? null
  }

  /** Every tab's current status — the CI poller derives its targets from this. */
  allSnapshots(): TabStatus[] {
    return [...this.tabs.values()].map((t) => t.status)
  }

  /** CI poller result for a tab. A success→failed flip pings attention so the
   *  renderer can surface the break. */
  setCi(tabId: TabId, ci: CiInfo | null): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    const prev = tab.status.ci
    if (JSON.stringify(prev) === JSON.stringify(ci)) return
    tab.status.ci = ci
    this.onUpdate(tab.status)
    if (prev?.state === 'success' && ci?.state === 'failed') {
      this.onAttention(tabId, 'CiFailed')
    }
  }

  /** CI poller result for one of a tab's extra workspace repos. */
  setRepoCi(tabId: TabId, root: string, ci: CiInfo | null): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    const entry = tab.status.extraRepos.find((r) => r.root === root)
    if (!entry || JSON.stringify(entry.ci) === JSON.stringify(ci)) return
    const prev = entry.ci
    entry.ci = ci
    this.onUpdate(tab.status)
    if (prev?.state === 'success' && ci?.state === 'failed') {
      this.onAttention(tabId, 'CiFailed')
    }
  }

  getCwd(tabId: TabId): string | null {
    return this.tabs.get(tabId)?.cwd ?? null
  }

  /** Extra working directories seen for this tab (`/add-dir`). */
  getAddedDirs(tabId: TabId): string[] {
    return this.tabs.get(tabId)?.status.addedDirs ?? []
  }

  /** Record a directory the tab's session was told to add. Idempotent, so
   *  re-issuing `/add-dir` for the same folder doesn't duplicate the section.
   *  Adding a folder again also lifts an earlier removal. */
  addDirectory(tabId: TabId, dir: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    const wasRemoved = tab.status.removedDirs.includes(dir)
    if (tab.status.addedDirs.includes(dir) && !wasRemoved) return
    if (wasRemoved) tab.status.removedDirs = tab.status.removedDirs.filter((d) => d !== dir)
    if (!tab.status.addedDirs.includes(dir)) tab.status.addedDirs = [...tab.status.addedDirs, dir]
    this.onUpdate(tab.status)
  }

  /** Folders the user removed again — suppressed wherever extra dirs come from. */
  getRemovedDirs(tabId: TabId): string[] {
    return this.tabs.get(tabId)?.status.removedDirs ?? []
  }

  /**
   * Drop an extra folder from a tab: out of the record, and onto the suppression
   * list so the statusline payload and the settings chain can't bring it back.
   * Claude Code has no removal of its own, so the live session keeps its access.
   */
  removeDirectory(tabId: TabId, dir: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return false
    tab.status.addedDirs = tab.status.addedDirs.filter((d) => d !== dir)
    if (!tab.status.removedDirs.includes(dir)) {
      tab.status.removedDirs = [...tab.status.removedDirs, dir]
    }
    this.onUpdate(tab.status)
    return true
  }

  /** How many tabs have a Claude session actively working right now. */
  busyCount(): number {
    let n = 0
    for (const tab of this.tabs.values()) if (tab.status.activity === 'busy') n++
    return n
  }

  /** Session ids seen this run — candidates for "our" daemon background agents. */
  seenSessionIds(): string[] {
    return [...this.seenSessions]
  }

  /** How many tabs currently have a live Claude session (busy or idle). */
  activeClaudeCount(): number {
    let n = 0
    for (const tab of this.tabs.values()) if (tab.status.claudeActive) n++
    return n
  }

  /** The tab's shell (the PTY) exited — the whole tab is done. */
  markExited(tabId: TabId, exitCode: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    tab.status.claudeActive = false
    tab.status.activity = 'exited'
    tab.status.exitCode = exitCode
    tab.status.busySince = null
    this.onUpdate(tab.status)
  }

  /** Optimistically mark a tab as hosting a live Claude session. Used when we
   *  restore a tab via `claude --resume`/`attach`: an attached background agent
   *  keeps its original --settings, so its statusline/hooks POST to a dead
   *  endpoint and never reach us — without this the Claude UI (status bar +
   *  prompt box) would stay hidden for that tab forever. A real statusline or
   *  SessionEnd, if one ever arrives, still overrides this.
   *
   *  `sessionId` is the id we revived from. Seeding it matters for the same
   *  reason: a tab whose session never POSTs would otherwise persist with no
   *  session id, so the *next* launch had nothing to revive from and silently
   *  demoted the tab to a plain terminal. */
  markClaudeActive(tabId: TabId, sessionId?: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    const seedId = sessionId && !tab.status.sessionId
    if (tab.status.claudeActive && !seedId) return
    tab.status.claudeActive = true
    if (seedId) {
      tab.status.sessionId = sessionId as string
      // a reattached background agent is "ours" again — quit should offer to
      // stop it alongside the agents we dispatched this run
      this.seenSessions.add(sessionId as string)
    }
    this.onUpdate(tab.status)
  }

  markRestarted(tabId: TabId): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    tab.homeUnclaimed = true
    tab.status.claudeActive = false
    tab.status.activity = 'idle'
    tab.status.exitCode = null
    tab.status.payload = null
    this.onUpdate(tab.status)
  }

  // The statusline reflects the tab's *foreground* Claude session (the one whose
  // TUI is rendering), so its session_id is the one we persist for restore. Hooks
  // are NOT used to set the session id: a background agent dispatched from inside
  // the tab inherits our per-tab --settings overlay and fires hooks against this
  // same tab, which used to clobber the id with the sub-agent's — but a bg agent
  // doesn't render the tab's statusline, so sourcing the id here avoids that.
  private handleStatusline(tabId: TabId, payload: StatuslinePayload): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    this.markFeedLive(tabId)
    if (payload.session_id) this.seenSessions.add(payload.session_id)
    tab.status.claudeActive = true
    tab.status.payload = payload
    if (payload.session_id) tab.status.sessionId = payload.session_id
    // A live session's folder is NEVER followed from payloads. current_dir
    // tracks the Bash tool's persistent cwd, and project_dir moves mid-session
    // too (the CLI's /cd + set_cwd relocate the session and rewrite
    // originalCwd). Adopting either drifts the tab's identity into another
    // repo, gets persisted, and corrupts the restore (wrong spawn dir + resume
    // from the wrong project). The session's own workspace, when different, is
    // shown by the renderer as a secondary folder chip instead (StatusBar).
    // Only the *launch* dir is adopted, once per session:
    this.adoptSessionHome(tabId, tab, payload)
    this.onUpdate(tab.status)
    void this.refreshGit(tabId)
  }

  /**
   * Home the tab on the folder its claude session was launched from — the first
   * project_dir a new session reports, which is the shell's cwd at launch.
   *
   * A tab is a plain terminal first: `cd`ing somewhere and running `claude`
   * there is the ordinary way to start one, and the folder chosen that way is
   * the session's root for its whole life, so it is the tab's too. Every later
   * payload of that session is ignored (see handleStatusline), and the flag is
   * re-armed only when the tab becomes a plain terminal again. A revived
   * conversation is registered with the flag already down: its home is the
   * folder we resumed it in and nothing a payload says may move it.
   *
   * The tab's seeded added dirs came from the old folder's settings, so they
   * are re-read from the new one — keeping any runtime `/add-dir` the tab
   * already observed, which belongs to the session rather than to a folder.
   */
  private adoptSessionHome(tabId: TabId, tab: TabState, payload: StatuslinePayload): void {
    if (!tab.homeUnclaimed) return
    const dir = payload.workspace?.project_dir
    if (!dir || !existsSync(dir)) return
    tab.homeUnclaimed = false
    if (dir === tab.cwd) return
    const staleSeed = settingsAddedDirs(tab.cwd)
    tab.cwd = dir
    tab.status.cwd = dir
    const observed = tab.status.addedDirs.filter((d) => !staleSeed.includes(d))
    const removed = new Set(tab.status.removedDirs)
    tab.status.addedDirs = [...new Set([...observed, ...settingsAddedDirs(dir)])]
      .filter((d) => !removed.has(d))
      .filter(existsSync)
    tab.gitFetchedAt = 0 // the branch/PR data belongs to the old folder
    this.onHomeChanged(tabId, dir)
  }

  // Hooks drive only the activity state (busy/idle/needs-attention) and the
  // claude-active gate — never the persisted session id (that comes from the
  // statusline; see handleStatusline). Every hook is honored regardless of its
  // session_id: a tab legitimately hosts several session ids over its life
  // (a new session after /clear, compaction, or restart), and gating activity
  // on a "first id wins" rule left the dot stuck busy on the tab's own turns.
  private handleHook(tabId: TabId, evt: HookEvent): void {
    const tab = this.tabs.get(tabId)
    // SessionEnd arrives for every tab while we're quitting; honoring it would
    // erase the very state we're about to persist (see freeze).
    if (!tab || this.frozen) return
    this.markFeedLive(tabId)
    if (evt.session_id) this.seenSessions.add(evt.session_id)
    // Note: the generic `Notification` hook is intentionally NOT mapped to an
    // activity state. It fires both for permission needs AND as a "waiting for
    // your input" ping that arrives AFTER `Stop` — mapping it to
    // needs-attention left tabs stuck yellow and blocked refocus-on-idle. Real
    // dialogs come through PermissionRequest/Elicitation, which precede Stop.
    const name = evt.hook_event_name ?? ''
    // SessionStart/End gate the whole Claude UI: the tab is a plain terminal
    // until a claude session starts, and returns to one when it ends.
    if (name === 'SessionStart') {
      tab.status.claudeActive = true
      tab.status.activity = 'idle'
      tab.status.busySince = null
      this.onUpdate(tab.status)
      return
    }
    if (name === 'SessionEnd') {
      // back to a plain terminal: the next `claude` may be started elsewhere
      tab.homeUnclaimed = true
      tab.status.claudeActive = false
      tab.status.activity = 'idle'
      tab.status.busySince = null
      tab.status.payload = null
      this.onUpdate(tab.status)
      return
    }
    const map: Record<string, ActivityState> = {
      UserPromptSubmit: 'busy',
      // A tool finishing means the turn is running again — importantly, this is
      // the first signal after the user answers a permission prompt (the
      // approved tool runs). It moves the tab off 'needs-attention' so the
      // renderer can return focus to the prompt box immediately.
      PostToolUse: 'busy',
      Stop: 'idle',
      PermissionRequest: 'needs-attention',
      Elicitation: 'needs-attention'
    }
    if (name === 'PermissionRequest' || name === 'Elicitation') {
      this.onAttention(tabId, name)
    }
    if (name === 'UserPromptSubmit') this.onTurnStart(tabId, tab.cwd)
    const next = map[name]
    if (!next) return
    tab.status.claudeActive = true
    // Keep the elapsed-timer origin stable across mid-turn tool completions;
    // only (re)start it when entering busy from a non-busy state.
    if (next === 'busy') {
      if (tab.status.activity !== 'busy') tab.status.busySince = Date.now()
    } else {
      tab.status.busySince = null
    }
    tab.status.activity = next
    this.onUpdate(tab.status)
    // Turn just ended — a safe moment to apply a branch-switch rename that
    // arrived mid-turn (see queueRename).
    if (next === 'idle') this.flushPendingRename(tabId, tab)
  }

  /** A real feed reached this tab — the synthetic attached poll stands down. */
  private markFeedLive(tabId: TabId): void {
    const feed = this.attached.get(tabId)
    if (feed) feed.live = true
  }

  private refreshAllGit(): void {
    for (const tabId of this.tabs.keys()) void this.refreshGit(tabId)
  }

  private async refreshGit(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab || this.frozen) return
    const now = Date.now()
    if (now - tab.gitFetchedAt < GIT_CACHE_MS) return
    tab.gitFetchedAt = now
    const git = await gitInfo(tab.cwd)
    const current = this.tabs.get(tabId)
    if (!current) return
    const extras = await extraRepoStatuses(current.status, git)
    // recency feed for the ⌘K recent-branches list; before the change check so
    // an unchanged checkout still counts as "worked on today"
    if (git?.branch) this.onBranchSeen(current.cwd, git.branch)
    for (const extra of extras) this.onBranchSeen(extra.root, extra.git.branch)
    const gitChanged = JSON.stringify(current.status.git) !== JSON.stringify(git)
    const extrasChanged = JSON.stringify(current.status.extraRepos) !== JSON.stringify(extras)
    if (!gitChanged && !extrasChanged) return
    const prevBranch = current.status.git?.branch ?? null
    current.status.git = git
    current.status.extraRepos = extras
    this.onUpdate(current.status)
    // A real branch switch (not the initial populate) on a live session:
    // rename the Claude session to match. The launch-time `--name` already
    // covered the branch the session started on, so prevBranch must be set.
    if (gitChanged && prevBranch && git?.branch && git.branch !== prevBranch) {
      this.queueRename(tabId, current, sessionNameForBranch(git.branch))
    }
  }

  /** Queue (or, if already idle, immediately apply) a `/rename` after a branch
   *  switch. Injecting mid-turn would interleave with a running turn, so we hold
   *  the name until the session next goes idle (see handleHook Stop → flush). */
  private queueRename(tabId: TabId, tab: TabState, name: string | null): void {
    if (!name || !tab.status.claudeActive || name === tab.lastRenamedName) return
    if (tab.status.activity === 'idle') {
      tab.pendingRename = null
      tab.lastRenamedName = name
      this.onRenameSession(tabId, name)
    } else {
      tab.pendingRename = name
    }
  }

  /** Apply a rename queued while the session was busy, now that it's idle. */
  private flushPendingRename(tabId: TabId, tab: TabState): void {
    const name = tab.pendingRename
    if (!name || !tab.status.claudeActive || name === tab.lastRenamedName) {
      tab.pendingRename = null
      return
    }
    tab.pendingRename = null
    tab.lastRenamedName = name
    this.onRenameSession(tabId, name)
  }
}

/** identity for de-duping workspace folders that live in the same repo */
function remoteKey(git: GitInfo | null): string | null {
  const repo = git?.remoteUrl ? parseRemote(git.remoteUrl) : null
  return repo ? `${repo.host}/${repo.owner}/${repo.repo}` : null
}

/**
 * Git state of the tab's OTHER workspace repos: every extra folder (added dirs,
 * a /cd move) that is a git repo with a remote different from the tab's own.
 * Existing CI results are carried over so a git refresh doesn't blank the dot.
 */
async function extraRepoStatuses(status: TabStatus, cwdGit: GitInfo | null): Promise<RepoStatus[]> {
  const cwdKey = remoteKey(cwdGit)
  const seen = new Set(cwdKey ? [cwdKey] : [])
  const prevCi = new Map(status.extraRepos.map((r) => [r.root, r.ci]))
  const out: RepoStatus[] = []
  for (const { path } of statusFolders(status).others) {
    if (!existsSync(path)) continue
    const git = await gitInfo(path)
    const key = remoteKey(git)
    if (!git || !key || seen.has(key)) continue
    seen.add(key)
    out.push({ root: path, git, ci: prevCi.get(path) ?? null })
  }
  return out
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', cwd, ...args],
      { timeout: 4_000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout.trim())
    )
  })
}

/** origin's URL, falling back to the repo's first remote whatever its name —
 *  a repo remoted as e.g. "BitBucket" is still part of the workspace. */
export async function firstRemoteUrl(cwd: string): Promise<string | null> {
  const origin = await runGit(cwd, ['remote', 'get-url', 'origin'])
  if (origin) return origin
  const first = (await runGit(cwd, ['remote']))?.split('\n')[0]?.trim()
  return first ? runGit(cwd, ['remote', 'get-url', first]) : null
}

async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const branch = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === null) return null
  const [porcelain, upstream, remoteUrl, topLevel] = await Promise.all([
    runGit(cwd, ['status', '--porcelain']),
    runGit(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    firstRemoteUrl(cwd),
    runGit(cwd, ['rev-parse', '--show-toplevel'])
  ])
  const changed = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
  let unpushed = 0
  if (upstream) {
    const count = await runGit(cwd, ['rev-list', '--count', `${upstream}..HEAD`])
    unpushed = count ? parseInt(count, 10) || 0 : 0
  }
  let behind = 0
  if (branch !== 'main') {
    for (const ref of ['main', 'origin/main']) {
      const count = await runGit(cwd, ['rev-list', '--count', `HEAD..${ref}`])
      if (count !== null) {
        behind = parseInt(count, 10) || 0
        break
      }
    }
  }
  const repo = parseRemote(remoteUrl ?? '')
  return {
    branch,
    changed,
    unpushed,
    behind,
    remoteUrl: remoteUrl ?? '',
    prUrl: repo ? pullRequestUrl(cwd, repo, branch) : null,
    hasWorkflows: topLevel ? existsSync(join(topLevel, '.github', 'workflows')) : false
  }
}
