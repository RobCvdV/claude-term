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
  activity: ActivityState
  /** epoch ms of the moment activity last flipped to busy (for elapsed timer) */
  busySince: number | null
  sessionId: string | null
  exitCode: number | null
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
