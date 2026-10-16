import { describe, expect, it } from 'vitest'
import { branchTicket } from './ticket-status'

describe('branchTicket', () => {
  it('takes the ticket key from a branch name', () => {
    expect(branchTicket('bugfix/MTX-11280-keep-started-ride-visible')).toBe('MTX-11280')
    expect(branchTicket('MTX-12')).toBe('MTX-12')
    expect(branchTicket('feature/tab-move-keys')).toBeNull()
    expect(branchTicket('main')).toBeNull()
  })
})
