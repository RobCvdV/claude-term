export type TabId = string

export type ActivityState = 'starting' | 'busy' | 'idle' | 'needs-attention' | 'ended' | 'exited'

/** Live notification-volume state (the audio-notifications plugin's scale knob,
 *  0-100%). `available` is false when the plugin's volume system isn't installed
 *  (no ~/.claude/audio_volume_scale and no vol.sh), so the UI hides the control. */
export interface VolumeState {
  pct: number
  muted: boolean
  available: boolean
}

/** A single volume mutation the renderer can request. */
export type VolumeOp = 'up' | 'down' | 'toggle' | number

/** Subset of the JSON Claude Code pipes to its statusLine command. */
export interface StatuslinePayload {
  session_id?: string
  cwd?: string
  model?: { id?: string; display_name?: string }
  workspace?: {
    current_dir?: string
    project_dir?: string
    added_dirs?: string[]
    git_worktree?: string
    repo?: { host?: string; owner?: string; name?: string }
  }
  version?: string
  output_style?: { name?: string }
  cost?: {
    total_cost_usd?: number
    total_duration_ms?: number
    total_api_duration_ms?: number
    total_lines_added?: number
    total_lines_removed?: number
  }
  context_window?: {
    total_input_tokens?: number
    total_output_tokens?: number
    context_window_size?: number
    used_percentage?: number
    remaining_percentage?: number
  }
  exceeds_200k_tokens?: boolean
  effort?: { level?: string }
  thinking?: { enabled?: boolean }
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number }
    seven_day?: { used_percentage?: number; resets_at?: number }
  }
  vim?: { mode?: string }
  agent?: { name?: string }
}

export interface HookEvent {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  [key: string]: unknown
}

export interface GitInfo {
  branch: string
  changed: number
  unpushed: number
  behind: number
  remoteUrl: string
  /** open PR for this branch, resolved in the background (null until known) */
  prUrl: string | null
  /** repo has .github/workflows — drives the Actions link */
  hasWorkflows: boolean
}

export type CiState = 'success' | 'failed' | 'running' | 'unknown'
export type CiProvider = 'jenkins' | 'circleci' | 'actions'

/** Latest CI build state for a tab's repo+branch, from the background poller. */
export interface CiInfo {
  provider: CiProvider
  state: CiState
  /** the build/run this state came from (falls back to the branch overview) */
  url: string
}

/** Projected time one rate-limit window hits 100% at the current pace. */
export interface WindowForecast {
  /** epoch seconds of the projected hit, null when pace ≈ 0 or data too thin */
  hitsAt: number | null
  /** the projected hit lands before the window resets — worth flagging */
  beforeReset: boolean
}

export interface RateForecast {
  fiveHour: WindowForecast
  sevenDay: WindowForecast
}

/** Git + CI state of one additional workspace repo (an added dir whose repo
 *  differs from the tab's own). Grouped under its folder name in the UI. */
export interface RepoStatus {
  /** absolute path of the workspace folder that surfaced this repo */
  root: string
  git: GitInfo
  ci: CiInfo | null
}

/** Everything the renderer needs to draw one tab's status bar. */
export interface TabStatus {
  tabId: TabId
  /** true while a claude session runs in the tab's shell (SessionStart..End).
   *  When false the tab is a plain terminal and the Claude UI is hidden. */
  claudeActive: boolean
  activity: ActivityState
  /** epoch ms of the moment activity last flipped to busy (for elapsed timer) */
  busySince: number | null
  sessionId: string | null
  exitCode: number | null
  /** most recent known cwd (updated from the statusline payload while a claude
   *  session runs); used to restore/resume the tab in the right folder. */
  cwd: string
  /** extra working directories added to the session with `/add-dir`, absolute.
   *  Only those submitted through the app's prompt box are seen — see
   *  added-dirs.ts. Persisted with the tab so they survive a restart. */
  addedDirs: string[]
  payload: StatuslinePayload | null
  git: GitInfo | null
  /** live CI state for this tab's repo+branch (null until the poller knows) */
  ci: CiInfo | null
  /** other workspace repos (added dirs in a different repo), with their own
   *  git + CI state — drives the grouped PR dropdown and extra CI links */
  extraRepos: RepoStatus[]
}

/** Which tab of the Help overlay to open (Help menu / ⌘/). */
export type HelpSection = 'howto' | 'guide'

/** One open pull request in the status bar's PR dropdown. */
export interface PrInfo {
  number: number
  title: string
  url: string
  /** the PR context menu may offer "Merge" (GitHub repo with push access) */
  canMerge: boolean
}

/** One workspace repo's open PRs, a group in the status-bar PR dropdown. */
export interface PrGroup {
  /** absolute path of the workspace folder this repo belongs to */
  root: string
  prs: PrInfo[]
}

/** A markdown document surfaced in the status-bar Docs overlay. */
export interface DocEntry {
  /** absolute path on disk */
  path: string
  /** display title: the file's first `# ` heading, else its file name */
  title: string
  /** modification time, epoch ms (used to sort plans newest-first) */
  mtime: number
}

/** Which status-bar label opened the overlay / which section to focus. */
export type DocGroup = 'plan' | 'roadmap' | 'docs'

/** A folder's markdown files, shown as one section in the docs overlay. */
export interface DocSection {
  /** section heading: the sub-folder's name, or the project name for root files */
  name: string
  entries: DocEntry[]
}

/** Markdown docs available for one project (tab), grouped for the overlay. */
export interface ProjectDocs {
  /** plan-mode plans (~/.claude/plans) this project's sessions created, newest first */
  plans: DocEntry[]
  /** ROADMAP.md (or the first roadmap*.md) in the repo root, if any */
  roadmap: DocEntry | null
  /** every *.md in the repo root or one sub-directory deep, grouped by folder:
   *  root files first, then each sub-folder that holds *.md, folder-name sorted */
  sections: DocSection[]
}

/** Above this size a config file is listed but not opened — a generated file
 *  that happens to match a pattern shouldn't be able to hang the editor. Shared
 *  policy: the main process enforces it, the window explains it. */
export const MAX_CONFIG_EDIT_BYTES = 2 * 1024 * 1024

/** One configuration/settings file surfaced in the status-bar Settings window. */
export interface ConfigEntry {
  /** absolute path on disk */
  path: string
  /** display label: the path relative to its scan root (posix separators) */
  rel: string
  /** modification time, epoch ms */
  mtime: number
  /** byte size — the window refuses to open very large files rather than
   *  hanging Monaco on a generated file that happens to match a pattern */
  size: number
}

/** One scan root's config files, shown as a section in the Settings window. */
export interface ConfigSection {
  /** section heading: the root folder's name */
  name: string
  /** absolute path of the root this section was scanned from */
  root: string
  /** shown under the heading when the root isn't the tab's own cwd */
  subtitle?: string
  entries: ConfigEntry[]
}

/** Config files available for one tab: its cwd, plus every added directory. */
export interface ProjectConfigFiles {
  sections: ConfigSection[]
  /** absolute path of the user-editable include/exclude pattern file; it is
   *  listed as its own section so it can be edited in the same editor */
  patternsFile: string
}

export interface SlashCommand {
  /** without the leading slash, e.g. "commit-commands:commit" */
  name: string
  description: string
  hint: string
  source: 'built-in' | 'user' | 'project' | 'plugin' | 'app'
}

/** One runnable package.json script, for the `/npm` picker. */
export interface NpmScript {
  /** '' for the root package.json, else the one-level-deep subfolder name */
  dir: string
  name: string
  command: string
}

/** Result of an in-app `git switch` triggered by the `/switch` command. */
/** One branch the user worked on, for the ⌘K palette's recent-branch recall. */
export interface BranchHistoryEntry {
  /** workspace folder the branch was seen checked out in */
  root: string
  branch: string
  /** epoch ms the branch was last seen checked out */
  lastUsed: number
}

export interface BranchSwitchResult {
  ok: boolean
  error?: string
}

export interface TabInfo {
  tabId: TabId
  cwd: string
  title: string
}

/** An unsubmitted prompt, with the image chips it still refers to. */
export interface PromptDraft {
  text: string
  /** `[imageN]` chip → the real @path/quoted path submit expands it back to */
  images: Record<string, string>
}

/** One tab as saved to disk between launches. */
export interface PersistedTab {
  cwd: string
  title: string
  /** the user renamed this tab, so don't let the shell's OSC title override it */
  manualTitle: boolean
  color?: string
  /** the claude session id to --resume, if one was running when we last saved */
  sessionId: string | null
  claudeActive: boolean
  /** `/add-dir` directories seen in this tab (absent for tabs saved before this
   *  was tracked, hence optional) */
  addedDirs?: string[]
  /** the tab's most recent submitted prompts, oldest first, so ↑ still recalls
   *  them after a restart. Trimmed on write — see prompt-history.ts. */
  promptHistory?: string[]
  /** half-written prompt left in the box — see prompt-drafts.ts */
  promptDraft?: PromptDraft
}

export interface PersistedSession {
  tabs: PersistedTab[]
  activeIndex: number
}

/** Engaged time on one ticket/project within a day or a whole range. */
export interface ActivityBucket {
  /** stable grouping key: the ticket id, else "project:branch" */
  key: string
  /** the MTX-style ticket id if the branch had one, else null */
  ticket: string | null
  /** what to show as the row label (ticket id, or the branch/folder name) */
  label: string
  /** distinct branch names the work happened on (a ticket can span repos) */
  branches: string[]
  /** repo folder name the work happened in */
  project: string
  /** wall-clock engaged hours (idle gaps capped out), 2-decimal float */
  hours: number
}

export interface ActivityDay {
  /** local calendar date, YYYY-MM-DD */
  date: string
  totalHours: number
  buckets: ActivityBucket[]
  /** epoch seconds of the first / last beat seen this day (whole workday span,
   *  including non-ticket work) — drives the suggested day length. 0 if none. */
  firstTs: number
  lastTs: number
  /** first→last span rounded UP to the next 30 min, or 8h when there's no span.
   *  The default (editable) total to dispatch across the day's tickets. */
  suggestedHours: number
}

/** Single-word worklog category; the Jira worklog comment. */
export type WorklogActivity = 'coding' | 'investigate' | 'testing' | 'reviewing'

/** One prepared (not-yet-posted) Jira worklog line. */
export interface WorklogPlanEntry {
  /** local YYYY-MM-DD the work happened */
  date: string
  /** MTX-style Jira issue key */
  issueKey: string
  /** hours to log, a multiple of 0.5 */
  hours: number
  activity: WorklogActivity
}

/** The dispatch the user confirmed in the panel, handed to the assistant to
 *  post via the Atlassian MCP. Written to ~/.claude/activity-worklog-plan.json. */
export interface WorklogPlan {
  generatedAt: number
  entries: WorklogPlanEntry[]
}

/** A worklog the assistant already posted (idempotency + ✓ badges).
 *  Stored in ~/.claude/activity-worklog-log.json under { logged: [...] }. */
export interface LoggedWorklog {
  date: string
  issueKey: string
  hours: number
  activity: WorklogActivity
  worklogId: string
  at: number
}

/** Whether the app has stored Jira credentials (and for whom). */
export interface JiraStatus {
  connected: boolean
  email?: string
}

/** A worklog that already exists in Jira (mine, within the panel's range). */
export interface BookedWorklog {
  /** local YYYY-MM-DD derived from the worklog's `started` */
  date: string
  issueKey: string
  hours: number
  worklogId: string
  comment?: string
}

/** Outcome of posting one WorklogPlanEntry straight to Jira. */
export interface BookResult {
  date: string
  issueKey: string
  hours: number
  ok: boolean
  error?: string
}

/** Aggregated activity for the requested trailing window. */
export interface ActivityReport {
  /** number of days the window spans (1 = today, 7, 30) */
  rangeDays: number
  totalHours: number
  /** most recent day first */
  days: ActivityDay[]
  /** per-ticket totals across the whole window, biggest first */
  totals: ActivityBucket[]
}
