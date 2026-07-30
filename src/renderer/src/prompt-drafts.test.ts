import { beforeEach, describe, expect, it } from 'vitest'
import {
  draftFor,
  DRAFT_PERSIST_MAX,
  forgetDraft,
  lastImageNumber,
  persistedDraftFor,
  restoreDraft,
  saveDraft
} from './prompt-drafts'

const TAB = 'tab-1'
const noImages = new Map<string, string>()

beforeEach(() => forgetDraft(TAB))

describe('saveDraft', () => {
  it('parks the text', () => {
    saveDraft(TAB, 'half a thought', noImages)
    expect(draftFor(TAB)?.text).toBe('half a thought')
  })

  it('drops the entry when the box is emptied, so a stale draft cannot resurrect', () => {
    saveDraft(TAB, 'something', noImages)
    saveDraft(TAB, '', noImages)
    expect(draftFor(TAB)).toBeUndefined()
  })

  it('treats whitespace-only as empty', () => {
    saveDraft(TAB, '   \n  ', noImages)
    expect(draftFor(TAB)).toBeUndefined()
  })

  it('keeps tabs independent', () => {
    saveDraft(TAB, 'mine', noImages)
    saveDraft('other', 'theirs', noImages)
    expect(draftFor(TAB)?.text).toBe('mine')
    forgetDraft('other')
  })

  // The chips are only labels; submit expands them back to real paths. Losing
  // the map means submitting a literal "[image1]".
  it('keeps the image chips the text still refers to', () => {
    const images = new Map([
      ['[image1]', '/tmp/a.png'],
      ['[image2]', '/tmp/b.png']
    ])
    saveDraft(TAB, 'look at [image1] and [image2]', images)
    expect(draftFor(TAB)?.images).toEqual({
      '[image1]': '/tmp/a.png',
      '[image2]': '/tmp/b.png'
    })
  })

  it('forgets a chip the user deleted from the text', () => {
    const images = new Map([
      ['[image1]', '/tmp/a.png'],
      ['[image2]', '/tmp/b.png']
    ])
    saveDraft(TAB, 'only [image2] survived', images)
    expect(draftFor(TAB)?.images).toEqual({ '[image2]': '/tmp/b.png' })
  })
})

describe('restoreDraft', () => {
  it('seeds a restored tab', () => {
    restoreDraft(TAB, { text: 'from last time', images: { '[image1]': '/tmp/a.png' } })
    expect(draftFor(TAB)).toEqual({ text: 'from last time', images: { '[image1]': '/tmp/a.png' } })
  })

  it('ignores a session saved before drafts existed', () => {
    restoreDraft(TAB, undefined)
    expect(draftFor(TAB)).toBeUndefined()
  })

  it('tolerates a draft with no images field', () => {
    restoreDraft(TAB, { text: 'plain' } as never)
    expect(draftFor(TAB)).toEqual({ text: 'plain', images: {} })
  })
})

describe('persistedDraftFor', () => {
  it('is undefined for a tab with no draft, so no key is written', () => {
    expect(persistedDraftFor(TAB)).toBeUndefined()
  })

  it('returns the draft for a tab that has one', () => {
    saveDraft(TAB, 'keep me', noImages)
    expect(persistedDraftFor(TAB)).toEqual({ text: 'keep me', images: {} })
  })

  it('keeps an enormous draft in memory but out of session.json', () => {
    const huge = 'x'.repeat(DRAFT_PERSIST_MAX + 1)
    saveDraft(TAB, huge, noImages)
    expect(draftFor(TAB)?.text).toBe(huge)
    expect(persistedDraftFor(TAB)).toBeUndefined()
  })

  it('persists a draft exactly at the limit', () => {
    saveDraft(TAB, 'x'.repeat(DRAFT_PERSIST_MAX), noImages)
    expect(persistedDraftFor(TAB)).toBeDefined()
  })

  // The point of the feature: type, quit, come back, it's still there — with the
  // chips still resolving to real paths.
  it('survives a save/restore round trip with its chips intact', () => {
    saveDraft(TAB, 'check [image1]', new Map([['[image1]', '/tmp/shot.png']]))
    const saved = persistedDraftFor(TAB)
    forgetDraft(TAB)
    restoreDraft(TAB, saved)
    expect(draftFor(TAB)).toEqual({
      text: 'check [image1]',
      images: { '[image1]': '/tmp/shot.png' }
    })
  })
})

describe('lastImageNumber', () => {
  it('is 0 with no chips', () => {
    expect(lastImageNumber({})).toBe(0)
  })

  it('resumes past the highest restored chip', () => {
    expect(lastImageNumber({ '[image1]': 'a', '[image3]': 'c' })).toBe(3)
  })

  it('is not confused by out-of-order keys', () => {
    expect(lastImageNumber({ '[image10]': 'j', '[image2]': 'b' })).toBe(10)
  })

  it('ignores anything that is not a chip', () => {
    expect(lastImageNumber({ nonsense: 'x', '[imageX]': 'y' })).toBe(0)
  })
})
