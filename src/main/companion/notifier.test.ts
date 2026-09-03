import { describe, expect, it } from 'vitest'
import type { ActivityState, TabStatus } from '../../shared/types'
import { MIN_TURN_FOR_IDLE_MS, Notifier, PER_TAB_COOLDOWN_MS } from './notifier'

let now = 1_700_000_000_000

function status(activity: ActivityState, over: Partial<TabStatus> = {}): TabStatus {
  return {
    tabId: 't1',
    claudeActive: true,
    activity,
    busySince: activity === 'busy' ? now : null,
    sessionId: 's1',
    exitCode: null,
    cwd: '/Users/rob/Dev/thing',
    addedDirs: [],
    removedDirs: [],
    payload: null,
    git: null,
    ci: null,
    extraRepos: [],
    ...over
  }
}

function notifier(hostFocused = false): Notifier {
  now = 1_700_000_000_000
  return new Notifier({ hostFocused: () => hostFocused, now: () => now })
}

describe('Notifier', () => {
  it('says nothing about the first status it ever sees', () => {
    // otherwise every tab pings the moment the app starts
    expect(notifier().consider(status('idle'))).toBeNull()
  })

  it('pushes when a session starts waiting on a human', () => {
    const n = notifier()
    n.consider(status('busy'))
    const notice = n.consider(status('needs-attention'))
    expect(notice).toMatchObject({
      kind: 'needs-attention',
      title: 'Claude needs your input',
      body: 'thing',
      data: { tabId: 't1', kind: 'needs-attention' }
    })
  })

  it('keeps the command and the path off the notification', () => {
    const n = notifier()
    n.consider(status('busy'))
    const notice = n.consider(status('needs-attention'))!
    const text = `${notice.title} ${notice.body}`
    expect(text).not.toContain('/Users/rob')
    expect(text).toBe('Claude needs your input thing')
  })

  it('stays quiet while the user is sitting in front of the app', () => {
    const n = notifier(true)
    n.consider(status('busy'))
    expect(n.consider(status('needs-attention'))).toBeNull()
  })

  it('pushes when a long turn finishes', () => {
    const n = notifier()
    n.consider(status('busy'))
    now += MIN_TURN_FOR_IDLE_MS
    expect(n.consider(status('idle'))?.kind).toBe('idle')
  })

  it('keeps quiet about a turn that finished while you watched it', () => {
    const n = notifier()
    n.consider(status('busy'))
    now += 2_000
    expect(n.consider(status('idle'))).toBeNull()
  })

  it('says nothing when the state has not actually changed', () => {
    const n = notifier()
    n.consider(status('busy'))
    now += MIN_TURN_FOR_IDLE_MS
    n.consider(status('idle'))
    now += PER_TAB_COOLDOWN_MS
    expect(n.consider(status('idle'))).toBeNull()
  })

  it('will not ping the same tab twice in quick succession', () => {
    const n = notifier()
    n.consider(status('busy'))
    expect(n.consider(status('needs-attention'))).not.toBeNull()
    // answered and immediately asking again
    n.consider(status('busy'))
    expect(n.consider(status('needs-attention'))).toBeNull()
  })

  it('pings again once the cooldown is over', () => {
    const n = notifier()
    n.consider(status('busy'))
    n.consider(status('needs-attention'))
    now += PER_TAB_COOLDOWN_MS
    n.consider(status('busy'))
    expect(n.consider(status('needs-attention'))).not.toBeNull()
  })

  it('reports a session that ended', () => {
    const n = notifier()
    n.consider(status('busy'))
    expect(n.consider(status('exited'))?.kind).toBe('exited')
  })

  it('names the folder the session moved to', () => {
    const n = notifier()
    n.consider(status('busy'))
    const notice = n.consider(
      status('needs-attention', {
        payload: { workspace: { current_dir: '/Users/rob/Dev/elsewhere' } }
      })
    )
    expect(notice?.body).toBe('elsewhere')
  })

  it('keeps tabs apart', () => {
    const n = notifier()
    n.consider(status('busy'))
    n.consider(status('needs-attention'))
    n.consider(status('busy', { tabId: 't2' }))
    // t1's cooldown must not silence t2
    expect(n.consider(status('needs-attention', { tabId: 't2' }))).not.toBeNull()
  })

  it('forgets a tab that has gone', () => {
    const n = notifier()
    n.consider(status('busy'))
    n.forget('t1')
    // with no history there is nothing to compare against
    expect(n.consider(status('needs-attention'))).toBeNull()
  })
})
