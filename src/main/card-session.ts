import { BrowserWindow, dialog, Menu } from 'electron'
import { basename } from 'path'
import type { BoardStart, BoardWorktree, TabStatus, WorkItem } from '../shared/types'
import type { PtyManager } from './pty-manager'
import type { StatusServer } from './status-server'
import type { TerminalWindows } from './terminal-windows'
import type { ActionResult } from './board-actions'
import { bringForward } from './background-mode'
import { appSettings } from './app-settings'
import {
  addWorktree,
  cloneState,
  isWorktree,
  prepareStart,
  remoteOf,
  removeWorktree,
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

const worktreeNote = (setup: string | undefined): string =>
  setup
    ? `This is a fresh git worktree; \`${setup}\` ran in the terminal before this session started.`
    : 'This is a fresh git worktree: dependencies are not installed and nothing is built yet.'

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

const RANK: Record<CloneState['kind'], number> = { here: 0, free: 1, takeover: 2, busy: 9 }

/** The clone an assistant's start uses, without asking: a usable one, sure ones first. */
export function autoChoice(
  item: WorkItem,
  states: CloneState[]
): { start: BoardStart; state: CloneState } | null {
  const best = item.starts
    .map((start, i) => ({
      start,
      state: states[i],
      rank: RANK[states[i].kind] - (start.sure ? 0.5 : 0)
    }))
    .filter((c) => c.state.kind !== 'busy')
    .sort((a, b) => a.rank - b.rank)[0]
  return best ? { start: best.start, state: best.state } : null
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
  /** `auto`: an assistant asked; pick a usable clone instead of showing the menu */
  pick: boolean | 'auto',
  /** added to the first prompt, e.g. what an assistant was asked to have it do */
  extra?: string
): Promise<ActionResult> {
  const item = deps.item(itemId)
  if (!item) return { ok: false, error: 'the card is no longer on the board' }
  if (!item.starts.length) return { ok: false, error: 'no local clone of this repo found' }
  const snaps = deps.snapshots()
  const states = await Promise.all(item.starts.map((s) => cloneState(item, s, snaps)))
  const direct = !pick && item.starts[0].sure && states[0].kind !== 'busy'
  const choice = direct
    ? { start: item.starts[0], state: states[0] }
    : pick === 'auto'
      ? autoChoice(item, states)
      : await choose(from, item, states)
  if (!choice && pick === 'auto') {
    const why = item.starts.map((s, i) => {
      const st = states[i]
      return `${basename(s.root)}: ${st.kind === 'busy' ? st.why : st.kind}`
    })
    return { ok: false, error: `every clone is busy (${why.join('; ')})` }
  }
  if (!choice) return { ok: false }

  let start: BoardStart
  let state: CloneState
  let note = ''
  let setup: string | undefined
  if ('worktreeOf' in choice) {
    const wt = await addWorktree(item, choice.worktreeOf)
    if (!wt.ok) return wt
    ;({ start } = wt)
    state = await cloneState(item, start, snaps)
    const repo = (await remoteOf(choice.worktreeOf))?.repo
    setup = (repo && appSettings().worktreeSetup?.[repo]) || undefined
    note = worktreeNote(setup)
  } else {
    ;({ start, state } = choice)
  }
  if (state.kind === 'busy') return { ok: false, error: `${basename(start.root)}: ${state.why}` }
  if (state.kind === 'here') {
    deps.windows.activate(state.tabId)
    return { ok: true }
  }

  const res = await prepareStart(item, start, snaps, [note, extra].filter(Boolean).join('\n\n'))
  if (!res.ok) return res
  const launch = { prompt: res.prompt || undefined, setup }
  if (state.kind === 'takeover') {
    deps.status.markRestarted(state.tabId)
    await deps.ptys.restart(state.tabId, { ...launch, resume: res.resume ?? undefined })
    if (res.resume) deps.status.markClaudeActive(state.tabId, res.resume)
    deps.windows.activate(state.tabId)
  } else {
    const win = deps.windows.focusedOrPrimary()
    if (!win) return { ok: false, error: 'no terminal window' }
    bringForward(win)
    win.webContents.send('folder:openTab', res.cwd, launch, res.resume)
  }
  deps.refresh()
  return res.warnings.length
    ? { ok: true, error: `Jira: ${res.warnings.join('; ')}` }
    : { ok: true }
}

/** The worktrees ▶ session made, to remove: those that can go first, without asking. */
export function worktreeMenu(
  win: BrowserWindow | null,
  worktrees: readonly BoardWorktree[],
  changed: () => void
): Promise<ActionResult> {
  return new Promise((resolve) => {
    if (!win || !worktrees.length) return resolve({ ok: false })
    let picked = false
    const remove = async (list: readonly BoardWorktree[]): Promise<void> => {
      const failed: string[] = []
      for (const wt of list) {
        const res = await removeWorktree(wt.root)
        if (!res.ok) failed.push(`${wt.branch}: ${res.error}`)
      }
      changed()
      resolve(failed.length ? { ok: false, error: failed.join('; ') } : { ok: true })
    }
    const keepOpen = async (wt: BoardWorktree): Promise<void> => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancel', 'Remove'],
        defaultId: 0,
        cancelId: 0,
        message: `Remove the worktree of ${wt.branch}?`,
        detail: 'Its work still looks open. The branch and its commits stay in the repo.'
      })
      if (response === 1) await remove([wt])
      else resolve({ ok: false })
    }
    const removable = (wt: BoardWorktree): boolean => !wt.inUse && !wt.dirty
    const sorted = [...worktrees].sort((a, b) => Number(!!b.stale) - Number(!!a.stale))
    const template: Electron.MenuItemConstructorOptions[] = sorted.map((wt) => {
      const state = wt.inUse
        ? 'open in a tab'
        : wt.dirty
          ? 'uncommitted changes'
          : (wt.stale ?? 'work still open')
      return {
        label: `Remove ${wt.repo} / ${wt.branch} — ${state}`,
        enabled: removable(wt),
        click: () => {
          picked = true
          void (wt.stale ? remove([wt]) : keepOpen(wt))
        }
      }
    })
    const done = sorted.filter((wt) => wt.stale && removable(wt))
    if (done.length > 1) {
      template.unshift(
        {
          label: `Remove all ${done.length} that can go`,
          click: () => {
            picked = true
            void remove(done)
          }
        },
        { type: 'separator' }
      )
    }
    // on macOS the close callback can fire before the item's click
    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => setTimeout(() => !picked && resolve({ ok: false }), 200)
    })
  })
}
