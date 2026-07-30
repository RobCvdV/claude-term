import type { PromptDraft, TabId } from '../../shared/types'

/**
 * Unsubmitted prompt text, per tab. Lives outside React because the PromptBox
 * unmounts (and disposes its Monaco model) on every tab switch, and is persisted
 * into session.json so half-written work survives a restart.
 *
 * The `[imageN]` chip map travels WITH the text. It has to: the chips are only
 * labels, and submit expands each one back to the real path it stands for. When
 * that map lived in a component ref it was wiped on remount, so a draft holding
 * a chip would submit the literal "[image1]" after a tab switch.
 */
const drafts = new Map<TabId, PromptDraft>()

// exposed for scripted E2E testing (CDP) — harmless at runtime. Guarded because
// this module is also imported by unit tests, which run without a DOM.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__promptDrafts = drafts
}

/** Beyond this a draft stays in memory but isn't written to session.json — that
 *  file is rewritten and snapshotted into session-backups/ on every change, and
 *  32k is already an enormous prompt (roughly 8k words). */
export const DRAFT_PERSIST_MAX = 32_000

/** Park a tab's draft. Blank text drops the entry, so a stale draft can't
 *  resurrect on the next mount. Only chips actually present in the text are
 *  kept, so deleted images don't accumulate. */
export function saveDraft(tabId: TabId, text: string, images: Map<string, string>): void {
  if (text.trim() === '') {
    drafts.delete(tabId)
    return
  }
  const used: Record<string, string> = {}
  for (const [chip, mention] of images) if (text.includes(chip)) used[chip] = mention
  drafts.set(tabId, { text, images: used })
}

export function draftFor(tabId: TabId): PromptDraft | undefined {
  return drafts.get(tabId)
}

/** Seed a restored tab's draft from session.json. */
export function restoreDraft(tabId: TabId, draft: PromptDraft | undefined): void {
  if (!draft?.text) return
  drafts.set(tabId, { text: draft.text, images: draft.images ?? {} })
}

/** Drop a closed tab's draft so it doesn't outlive the tab. */
export function forgetDraft(tabId: TabId): void {
  drafts.delete(tabId)
}

/**
 * Where the `[imageN]` counter must resume so a newly dropped image can't reuse
 * a label a restored draft is still holding. Highest N in the map, or 0.
 */
export function lastImageNumber(images: Record<string, string>): number {
  let max = 0
  for (const chip of Object.keys(images)) {
    const n = Number(/^\[image(\d+)\]$/.exec(chip)?.[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/** What to persist for a tab, or undefined when there's nothing worth saving. */
export function persistedDraftFor(tabId: TabId): PromptDraft | undefined {
  const draft = drafts.get(tabId)
  if (!draft || draft.text.length > DRAFT_PERSIST_MAX) return undefined
  return draft
}
