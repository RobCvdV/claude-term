import { describe, expect, it } from 'vitest'
import type { BranchPr, TicketStatus, WorkItem } from '../../shared/types'
import { ciLabel, prReviewLabel, prTone, startChip, ticketTone } from './work-status'

const pr = (p: Partial<BranchPr>): BranchPr => ({
  url: 'u',
  number: 1,
  title: 't',
  review: 'pending',
  approvals: 0,
  draft: false,
  comments: null,
  ...p
})
const ticket = (status: string, category: TicketStatus['category']): TicketStatus => ({
  key: 'MTX-1',
  status,
  category,
  summary: '',
  assignee: null
})

describe('work-status', () => {
  it('colours PR review states', () => {
    expect(prTone(pr({}))).toBe('tone-orange')
    expect(prTone(pr({ review: 'approved', approvals: 1 }))).toBe('tone-green')
    expect(prTone(pr({ review: 'changes' }))).toBe('tone-red')
    expect(prReviewLabel(pr({ review: 'approved', approvals: 2 }))).toBe('approved ×2')
    expect(prReviewLabel(pr({ draft: true, review: 'approved' }))).toBe('draft')
  })

  it('reads board stages by name', () => {
    expect(ticketTone(ticket('Active', 'progress'))).toBe('tone-blue')
    expect(ticketTone(ticket('Peer review', 'progress'))).toBe('tone-magenta')
    expect(ticketTone(ticket('Deploy', 'progress'))).toBe('tone-cyan')
    expect(ticketTone(ticket('Done', 'done'))).toBe('tone-green')
    expect(ticketTone(ticket('To Do', 'todo'))).toBe('tone-dim')
  })

  it('labels running CI with progress', () => {
    expect(ciLabel({ state: 'running', progress: 45 })).toBe('running 45%')
    expect(ciLabel({ state: 'success' })).toBe('passed')
  })
})

describe('startChip', () => {
  const card = (plan: WorkItem['plan']): WorkItem => ({ plan, starts: [] }) as unknown as WorkItem

  it('says what a click does', () => {
    expect(startChip(card(null)).label).toBe('▶ session')
    expect(startChip(card({ kind: 'resume', root: '/d/app', takeover: false })).label).toBe(
      '↻ resume'
    )
    const takeover = startChip(card({ kind: 'new', root: '/d/app', takeover: true }))
    expect(takeover.label).toBe('▶ new · idle tab')
    expect(takeover.title).toContain('app, in its idle tab')
    const busy = startChip(card({ kind: 'choose', why: 'uncommitted changes on main' }))
    expect(busy).toMatchObject({ label: '▶ choose…' })
    expect(busy.title).toContain('busy: uncommitted changes on main')
  })
})
