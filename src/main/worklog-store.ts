import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { LoggedWorklog, WorklogPlan } from '../shared/types'

// The panel writes the confirmed dispatch here; the assistant reads it and posts
// each line to Jira via the Atlassian MCP, then records what it posted in the
// log file (so re-runs never double-post and the panel can show ✓ badges).
const PLAN_PATH = join(homedir(), '.claude', 'activity-worklog-plan.json')
const LOG_PATH = join(homedir(), '.claude', 'activity-worklog-log.json')

export function saveWorklogPlan(plan: WorklogPlan): void {
  try {
    writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2))
  } catch {
    /* best effort — a failed write just means nothing to hand off */
  }
}

export function readLoggedWorklogs(): LoggedWorklog[] {
  if (!existsSync(LOG_PATH)) return []
  try {
    const data = JSON.parse(readFileSync(LOG_PATH, 'utf8')) as { logged?: LoggedWorklog[] }
    return Array.isArray(data.logged) ? data.logged : []
  } catch {
    return []
  }
}
