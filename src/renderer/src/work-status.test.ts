import { describe, expect, it } from 'vitest'
import type { BranchPr, TicketStatus } from '../../shared/types'
import { ciLabel, prReviewLabel, prTone, ticketTone } from './work-status'

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
    expect(prTone(pr({}))).toBe('tone-blue')
    expect(prTone(pr({ review: 'approved', approvals: 1 }))).toBe('tone-green')
    expect(prTone(pr({ review: 'changes' }))).toBe('tone-orange')
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
    expect(ciLabel({ provider: 'jenkins', state: 'running', url: '', progress: 45 })).toBe(
      'running 45%'
    )
    expect(ciLabel({ provider: 'jenkins', state: 'success', url: '' })).toBe('passed')
  })
})
