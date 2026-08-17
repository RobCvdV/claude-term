import type { TabId } from '../shared/types'
import type { Checkpoint } from './checkpoints'

/**
 * The recent restore points of each tab, newest last. Bounded: a checkpoint
 * pins a commit object with a ref, so forgetting one has to hand it back for
 * its ref to be deleted — that is what `onEvict` is for.
 */

/** Enough to undo the last few turns; a session's whole history is what git is for. */
const PER_TAB = 10

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
