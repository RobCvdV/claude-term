import { BrowserWindow, Menu } from 'electron'
import { basename } from 'path'
import type { BoardStart, TabStatus, WorkItem } from '../shared/types'
import type { PtyManager } from './pty-manager'
import type { StatusServer } from './status-server'
import type { TerminalWindows } from './terminal-windows'
import type { ActionResult } from './board-actions'
import { bringForward } from './background-mode'
import {
  addWorktree,
  cloneState,
  isWorktree,
  prepareStart,
  remoteOf,
  type CloneState
} from './work-start'

export interface CardSessionDeps {
  item: (id: string) => WorkItem | undefined
  snapshots: () => TabStatus[]
  windows: TerminalWindows
  ptys: PtyManager
  status: StatusServer
  /** the board re-sweeps, so a new worktree shows up as a clone */
  refresh: () => void
}

type Choice = { start: BoardStart; state: CloneState } | { worktreeOf: string }

const WORKTREE_NOTE =
  'This is a fresh git worktree: dependencies are not installed and nothing is built yet.'

function describe(item: WorkItem, start: BoardStart, state: CloneState): string {
  const what = start.branch ?? (item.ticket ? 'ticket branch' : 'current branch')
  const how =
    state.kind === 'here'
      ? ' — go to its tab'
      : state.kind === 'takeover'
        ? ' — take over its idle tab'
        : state.kind === 'busy'
          ? ` — ${state.why}`
          : ''
  return `${basename(start.root)} — ${what}${how}`
}

/** Every clone with its state, then a new worktree per repo; null when dismissed. */
async function choose(
  win: BrowserWindow | null,
  item: WorkItem,
  states: CloneState[]
): Promise<Choice | null> {
  const switching = !!item.ticket || item.starts.some((s) => s.branch)
  const mains = new Map<string, string>()
  if (switching) {
    for (const s of item.starts) {
      const ref = isWorktree(s.root) ? null : await remoteOf(s.root)
      if (ref && !mains.has(ref.repo)) mains.set(ref.repo, s.root)
    }
  }
  return new Promise((resolve) => {
    if (!win) return resolve(null)
    const template: Electron.MenuItemConstructorOptions[] = item.starts.map((start, i) => ({
      label: describe(item, start, states[i]),
      enabled: states[i].kind !== 'busy',
      click: () => resolve({ start, state: states[i] })
    }))
    if (mains.size) template.push({ type: 'separator' })
    for (const [repo, root] of mains) {
      template.push({
        label: `New worktree of ${repo}`,
        click: () => resolve({ worktreeOf: root })
      })
    }
    // on macOS the close callback can fire before the item's click
    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => setTimeout(() => resolve(null), 200)
    })
  })
}

/**
 * "▶ session" on a Work board card. A clone that is sure and usable is used
 * right away; otherwise (or on right-click) a menu shows every clone's state.
 * The session resumes the branch's last conversation, or a new one is asked
 * about the card: in a new tab, or in the clone's own idle tab.
 */
export async function startFromCard(
  deps: CardSessionDeps,
  from: BrowserWindow | null,
  itemId: string,
  pick: boolean
): Promise<ActionResult> {
  const item = deps.item(itemId)
  if (!item) return { ok: false, error: 'the card is no longer on the board' }
  if (!item.starts.length) return { ok: false, error: 'no local clone of this repo found' }
  const snaps = deps.snapshots()
  const states = await Promise.all(item.starts.map((s) => cloneState(item, s, snaps)))
  const direct = !pick && item.starts[0].sure && states[0].kind !== 'busy'
  const choice = direct
    ? { start: item.starts[0], state: states[0] }
    : await choose(from, item, states)
  if (!choice) return { ok: false }

  let start: BoardStart
  let state: CloneState
  let note = ''
  if ('worktreeOf' in choice) {
    const wt = await addWorktree(item, choice.worktreeOf)
    if (!wt.ok) return wt
    ;({ start } = wt)
    state = await cloneState(item, start, snaps)
    note = WORKTREE_NOTE
  } else {
    ;({ start, state } = choice)
  }
  if (state.kind === 'busy') return { ok: false, error: `${basename(start.root)}: ${state.why}` }
  if (state.kind === 'here') {
    deps.windows.activate(state.tabId)
    return { ok: true }
  }

  const res = await prepareStart(item, start, snaps, note)
  if (!res.ok) return res
  const launch = { resume: res.resume ?? undefined, prompt: res.prompt || undefined }
  if (state.kind === 'takeover') {
    deps.status.markRestarted(state.tabId)
    await deps.ptys.restart(state.tabId, launch)
    if (res.resume) deps.status.markClaudeActive(state.tabId, res.resume)
    deps.windows.activate(state.tabId)
  } else {
    const win = deps.windows.focusedOrPrimary()
    if (!win) return { ok: false, error: 'no terminal window' }
    bringForward(win)
    win.webContents.send('folder:openTab', res.cwd, res.prompt, res.resume)
  }
  deps.refresh()
  return res.warnings.length
    ? { ok: true, error: `Jira: ${res.warnings.join('; ')}` }
    : { ok: true }
}
