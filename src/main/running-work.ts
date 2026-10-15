import type { HookEvent, RunningWork } from '../shared/types'

const MAX_LABEL = 200

interface BackgroundTask {
  id?: string
  type?: string
  status?: string
  description?: string
  command?: string
}

/** The background tasks a Stop hook says the session left running. */
export function backgroundWork(evt: HookEvent): RunningWork[] {
  const tasks = Array.isArray(evt.background_tasks)
    ? (evt.background_tasks as BackgroundTask[])
    : []
  return tasks
    .map((t) => ({
      kind: t.type || 'task',
      label: (t.command || t.description || '').split('\n')[0].slice(0, MAX_LABEL),
      since: null,
      ...(t.id ? { id: t.id } : {})
    }))
    .filter((w) => w.label)
}

/**
 * What keeps a tab busy outside a turn. The shell's own command is left out
 * while a Claude session runs: that command is the session.
 */
export function runningOf(
  claudeActive: boolean,
  shell: { command: string; since: number } | null,
  background: RunningWork[]
): RunningWork[] {
  const own =
    shell && !claudeActive
      ? [{ kind: 'shell', label: shell.command.slice(0, MAX_LABEL), since: shell.since }]
      : []
  return [...own, ...(claudeActive ? background : [])]
}
