export type TabId = string

export type ActivityState = 'starting' | 'busy' | 'idle' | 'needs-attention' | 'ended' | 'exited'

/** Subset of the JSON Claude Code pipes to its statusLine command. */
export interface StatuslinePayload {
  session_id?: string
  cwd?: string
  model?: { id?: string; display_name?: string }
  workspace?: {
    current_dir?: string
    project_dir?: string
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
  payload: StatuslinePayload | null
  git: GitInfo | null
}

export interface SlashCommand {
  /** without the leading slash, e.g. "commit-commands:commit" */
  name: string
  description: string
  hint: string
  source: 'built-in' | 'user' | 'project' | 'plugin'
}

export interface TabInfo {
  tabId: TabId
  cwd: string
  title: string
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
}

export interface PersistedSession {
  tabs: PersistedTab[]
  activeIndex: number
}
