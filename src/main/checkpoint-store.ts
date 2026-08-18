import type { TabId } from '../shared/types'
import type { Checkpoint } from './checkpoints'

/**
 * The recent restore points of each tab, newest last. Bounded: a checkpoint
 * pins a commit object with a ref, so forgetting one has to hand it back for
 * its ref to be deleted — that is what `onEvict` is for.
 */

/** Enough to undo the last few turns; a session's whole history is what git is for. */
const PER_TAB = 10

/** A checkpoint is taken as the prompt is submitted and the transcript stamps
 *  the same message, so the two are seconds apart at most. */
const TOLERANCE_MS = 60_000

export class CheckpointStore {
  private byTab = new Map<TabId, Checkpoint[]>()

  constructor(
    private onEvict: (cp: Checkpoint) => void,
    private perTab = PER_TAB
  ) {}

  add(tabId: TabId, cp: Checkpoint): void {
    const list = this.byTab.get(tabId) ?? []
    list.push(cp)
    while (list.length > this.perTab) {
      const dropped = list.shift()
      if (dropped) this.onEvict(dropped)
    }
    this.byTab.set(tabId, list)
  }

  /** The point the current turn started from. */
  latest(tabId: TabId): Checkpoint | null {
    const list = this.byTab.get(tabId)
    return list?.length ? list[list.length - 1] : null
  }

  /**
   * The point taken closest to `atMs` — how a turn from the transcript finds its
   * checkpoint. Matched on time rather than by counting back, because the two
   * lists can drift: a prompt the app injects (a `/rename`, a branch-switch FYI)
   * takes a checkpoint without leaving a user message behind, and turns from
   * before this app run have no checkpoint at all. Nothing within the tolerance
   * means that turn cannot be undone, and the UI says so.
   */
  near(tabId: TabId, atMs: number, toleranceMs = TOLERANCE_MS): Checkpoint | null {
    let best: Checkpoint | null = null
    let bestGap = Infinity
    for (const cp of this.byTab.get(tabId) ?? []) {
      const gap = Math.abs(cp.at - atMs)
      if (gap <= toleranceMs && gap < bestGap) {
        best = cp
        bestGap = gap
      }
    }
    return best
  }

  count(tabId: TabId): number {
    return this.byTab.get(tabId)?.length ?? 0
  }

  /** The tab is gone: drop its points so their refs go with it. */
  forget(tabId: TabId): void {
    for (const cp of this.byTab.get(tabId) ?? []) this.onEvict(cp)
    this.byTab.delete(tabId)
  }

  forgetAll(): void {
    for (const tabId of [...this.byTab.keys()]) this.forget(tabId)
  }
}
