import { BrowserWindow, dialog } from 'electron'
import type { BoardPr, WorkItem } from '../shared/types'
import { ticketStage, type TicketStage } from '../shared/work-rules'
import { mergeable } from '../shared/work-board'
import { parseRemote } from '../shared/repo-links'
import { moveTicket } from './jira-client'
import { bitbucketPost } from './bitbucket-api'
import { forgetBitbucketPrs } from './bitbucket-prs'
import { mergeGithubPr } from './pr-list'

export type ActionResult = { ok: boolean; error?: string }

async function ask(win: BrowserWindow | null, opts: Electron.MessageBoxOptions): Promise<number> {
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts)
  return response
}

const stageLabel = (stage: TicketStage): string => (stage === 'review' ? 'Peer review' : 'Deploy')

/** Move a ticket on the board, after a confirmation — others watch that board too. */
export async function confirmAndMove(
  win: BrowserWindow | null,
  key: string,
  stage: 'review' | 'deploy'
): Promise<ActionResult> {
  const label = stageLabel(stage)
  const response = await ask(win, {
    type: 'question',
    buttons: ['Cancel', `Move to ${label}`],
    defaultId: 1,
    cancelId: 0,
    message: `Move ${key} to ${label}?`
  })
  if (response !== 1) return { ok: false }
  try {
    await moveTicket(key, stage)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function merge(pr: BoardPr): Promise<void> {
  const ref = parseRemote(pr.url.replace(/\/(pull|pull-requests)\/\d+.*$/, ''))
  if (!ref) throw new Error('not a GitHub or Bitbucket PR')
  if (ref.host === 'github') return mergeGithubPr(pr.url, `${ref.owner}/${ref.repo}`)
  await bitbucketPost(`/repositories/${ref.owner}/${ref.repo}/pullrequests/${pr.number}/merge`, {
    type: 'pullrequest'
  })
  forgetBitbucketPrs(ref)
}

/**
 * Merge a card's PR after a confirmation. When that was the ticket's last
 * open PR, offer to move the ticket on to Deploy.
 */
export async function mergeFromCard(
  win: BrowserWindow | null,
  item: WorkItem,
  pr: BoardPr
): Promise<ActionResult> {
  if (!mergeable(pr)) return { ok: false, error: 'not approved and green' }
  const response = await ask(win, {
    type: 'warning',
    buttons: ['Cancel', 'Merge'],
    defaultId: 0,
    cancelId: 0,
    message: `Merge ${pr.repo.split('/').pop()} #${pr.number}?`,
    detail: `${pr.title}\n\nMerges into the base branch — this may trigger a release.`
  })
  if (response !== 1) return { ok: false }
  try {
    await merge(pr)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const t = item.ticket
  const last = item.prs.every((p) => p.url === pr.url)
  if (t && last && ['todo', 'active', 'review'].includes(ticketStage(t))) {
    const moved = await confirmAndMove(win, t.key, 'deploy')
    if (moved.error) return { ok: true, error: `merged, but Jira: ${moved.error}` }
  }
  return { ok: true }
}
