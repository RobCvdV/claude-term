import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetPromptHistory,
  historyToPersist,
  HISTORY_MAX,
  HISTORY_PERSIST_MAX,
  HISTORY_PERSIST_MAX_ENTRY,
  HISTORY_PERSIST_MAX_TOTAL,
  persistedHistoryFor,
  promptHistoryFor,
  pushPrompt,
  restorePromptHistory
} from './prompt-history'

const TAB = 'tab-1'

beforeEach(() => forgetPromptHistory(TAB))

describe('pushPrompt', () => {
  it('keeps prompts oldest first', () => {
    pushPrompt(TAB, 'first')
    pushPrompt(TAB, 'second')
    expect(promptHistoryFor(TAB)).toEqual(['first', 'second'])
  })

  it('collapses consecutive duplicates, as a shell does', () => {
    pushPrompt(TAB, 'same')
    pushPrompt(TAB, 'same')
    expect(promptHistoryFor(TAB)).toEqual(['same'])
  })

  it('keeps a repeat that is not consecutive', () => {
    pushPrompt(TAB, 'a')
    pushPrompt(TAB, 'b')
    pushPrompt(TAB, 'a')
    expect(promptHistoryFor(TAB)).toEqual(['a', 'b', 'a'])
  })

  it('drops the oldest past HISTORY_MAX', () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++) pushPrompt(TAB, `p${i}`)
    const list = promptHistoryFor(TAB)
    expect(list).toHaveLength(HISTORY_MAX)
    expect(list[0]).toBe('p5')
    expect(list[list.length - 1]).toBe(`p${HISTORY_MAX + 4}`)
  })

  it('keeps tabs independent', () => {
    pushPrompt(TAB, 'mine')
    pushPrompt('other', 'theirs')
    expect(promptHistoryFor(TAB)).toEqual(['mine'])
    forgetPromptHistory('other')
  })
})

describe('restorePromptHistory', () => {
  it('seeds a restored tab', () => {
    restorePromptHistory(TAB, ['old', 'newer'])
    expect(promptHistoryFor(TAB)).toEqual(['old', 'newer'])
  })

  it('leaves the tab empty for a session saved before this existed', () => {
    restorePromptHistory(TAB, undefined)
    expect(promptHistoryFor(TAB)).toEqual([])
  })

  it('appends onto restored history', () => {
    restorePromptHistory(TAB, ['old'])
    pushPrompt(TAB, 'new')
    expect(promptHistoryFor(TAB)).toEqual(['old', 'new'])
  })
})

describe('forgetPromptHistory', () => {
  it('drops a closed tab so a later tab cannot inherit it', () => {
    pushPrompt(TAB, 'gone')
    forgetPromptHistory(TAB)
    expect(promptHistoryFor(TAB)).toEqual([])
  })
})

describe('historyToPersist', () => {
  it('keeps only the newest HISTORY_PERSIST_MAX, oldest first', () => {
    const list = Array.from({ length: HISTORY_PERSIST_MAX + 10 }, (_, i) => `p${i}`)
    const kept = historyToPersist(list)
    expect(kept).toHaveLength(HISTORY_PERSIST_MAX)
    expect(kept[kept.length - 1]).toBe(`p${HISTORY_PERSIST_MAX + 9}`)
    expect(kept[0]).toBe(`p${10}`)
  })

  it('passes a short history through untouched', () => {
    expect(historyToPersist(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('is empty for an empty history', () => {
    expect(historyToPersist([])).toEqual([])
  })

  // session.json is rewritten and snapshotted into session-backups/ on every
  // change, so one pasted wall of text must not ride along 20 times over.
  it('skips an oversized entry but keeps the ones around it', () => {
    const huge = 'x'.repeat(HISTORY_PERSIST_MAX_ENTRY + 1)
    expect(historyToPersist(['before', huge, 'after'])).toEqual(['before', 'after'])
  })

  it('keeps an entry exactly at the size limit', () => {
    const atLimit = 'x'.repeat(HISTORY_PERSIST_MAX_ENTRY)
    expect(historyToPersist([atLimit])).toEqual([atLimit])
  })

  it('stops at the total budget', () => {
    const chunk = 'x'.repeat(HISTORY_PERSIST_MAX_ENTRY)
    const list = Array.from({ length: 10 }, () => chunk)
    const kept = historyToPersist(list)
    expect(kept.length).toBe(Math.floor(HISTORY_PERSIST_MAX_TOTAL / HISTORY_PERSIST_MAX_ENTRY))
    expect(kept.join('').length).toBeLessThanOrEqual(HISTORY_PERSIST_MAX_TOTAL)
  })

  // Walking newest→oldest matters: filling the budget from the front would keep
  // stale prompts and drop the ones you actually just typed.
  it('drops the oldest entries when the budget runs out', () => {
    // four max-size entries exactly fill the budget, so 'oldest' cannot fit
    const chunks = Array.from({ length: 4 }, (_, i) =>
      `${i}`.padEnd(HISTORY_PERSIST_MAX_ENTRY, 'x')
    )
    const kept = historyToPersist(['oldest', ...chunks])
    expect(kept).toEqual(chunks)
    expect(kept).not.toContain('oldest')
  })
})

describe('persistedHistoryFor', () => {
  it('is undefined for a tab that never submitted anything, so no key is written', () => {
    expect(persistedHistoryFor(TAB)).toBeUndefined()
  })

  it('returns the trimmed history for a tab that has one', () => {
    pushPrompt(TAB, 'hello')
    expect(persistedHistoryFor(TAB)).toEqual(['hello'])
  })

  it('is undefined when every entry was too big to persist', () => {
    pushPrompt(TAB, 'x'.repeat(HISTORY_PERSIST_MAX_ENTRY + 1))
    expect(persistedHistoryFor(TAB)).toBeUndefined()
  })

  // The point of the feature: submit, quit, come back, ↑ still works.
  it('survives a save/restore round trip', () => {
    pushPrompt(TAB, 'first prompt')
    pushPrompt(TAB, 'second prompt')
    const saved = persistedHistoryFor(TAB)
    forgetPromptHistory(TAB)
    restorePromptHistory(TAB, saved)
    expect(promptHistoryFor(TAB)).toEqual(['first prompt', 'second prompt'])
  })
})
