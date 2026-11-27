import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, Menu: {} }))

import type { BoardStart, WorkItem } from '../shared/types'
import { autoChoice } from './card-session'
import type { CloneState } from './work-start'

const start = (root: string, sure = false): BoardStart => ({ root, branch: null, sure })
const item = (starts: BoardStart[]): WorkItem => ({ starts }) as WorkItem

describe('autoChoice', () => {
  it('takes an open tab on the card first, then a free sure clone, then any usable one', () => {
    const starts = [start('/tms'), start('/tms-2', true), start('/tms-3')]
    const free: CloneState = { kind: 'free' }
    expect(autoChoice(item(starts), [free, free, free])?.start.root).toBe('/tms-2')
    expect(autoChoice(item(starts), [free, free, { kind: 'here', tabId: 't3' }])?.start.root).toBe(
      '/tms-3'
    )
    expect(
      autoChoice(item(starts), [
        { kind: 'takeover', tabId: 't1' },
        { kind: 'busy', why: 'uncommitted changes on main' },
        free
      ])?.start.root
    ).toBe('/tms-3')
  })

  it('has nothing when every clone is busy', () => {
    const busy: CloneState = { kind: 'busy', why: 'a working tab is on main' }
    expect(autoChoice(item([start('/tms'), start('/tms-2')]), [busy, busy])).toBeNull()
  })
})
