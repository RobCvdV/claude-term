import type { TabId } from '../shared/types'

/**
 * Everything one tab holds in the main process. Closing a tab has to release
 * all of it; leaving any behind is how a tab keeps living after the renderer
 * has forgotten it (see disposeAll).
 */
export interface TabResources {
  /** Detached windows go first: they may prompt to save, and they resolve their
   *  cwd/roots through the tab's status, which the unregister below removes. */
  closeDocs: (tabId: TabId) => Promise<void>
  killPty: (tabId: TabId) => void
  /** Held prompts can no longer be answered — hand them back to the terminal. */
  releaseParked: (tabId: TabId) => void
  forgetQueued: (tabId: TabId) => void
  forgetNotices: (tabId: TabId) => void
  unregister: (tabId: TabId) => void
  forgetCheckpoints: (tabId: TabId) => void
}

export async function disposeTab(tabId: TabId, r: TabResources): Promise<void> {
  await r.closeDocs(tabId)
  r.killPty(tabId)
  r.releaseParked(tabId)
  r.forgetQueued(tabId)
  r.forgetNotices(tabId)
  r.unregister(tabId)
  r.forgetCheckpoints(tabId)
}

/**
 * Drop every tab the main process still holds. Called once by each renderer as
 * it loads, because a fresh renderer owns nothing: anything still registered
 * belongs to a previous load (a reload, HMR in dev, or a crash) and its PTY is
 * still running.
 *
 * Leaving them cost real damage: the restore that follows spawns a second
 * `claude --resume` on the *same* conversation, the abandoned tab keeps showing
 * up in a companion phone's session list as a ghost row, and a prompt sent to
 * that row goes into the abandoned PTY — typed into a claude nobody is watching
 * and, to the person who sent it, simply lost.
 */
export async function disposeAll(tabIds: readonly TabId[], r: TabResources): Promise<number> {
  for (const tabId of tabIds) await disposeTab(tabId, r)
  return tabIds.length
}
