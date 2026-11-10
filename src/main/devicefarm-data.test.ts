import { describe, expect, it } from 'vitest'
import { e2eSummary } from '../shared/e2e'
import type { E2eRun } from '../shared/types'
import { consoleUrl, groupOf, latestRuns, projectOf, runState, type DfRun } from './devicefarm-data'

const ARN = 'arn:aws:devicefarm:us-west-2:123456789012:run:proj-1/run-'

describe('groupOf', () => {
  it('takes the group and build from a Driver Next run name', () => {
    expect(
      groupOf(
        'mmx-next-workingHours-bugfix/MTX-11521-dark-theme #9409 92d75124',
        'bugfix/MTX-11521-dark-theme'
      )
    ).toEqual({ group: 'workingHours', build: '#9409' })
  })

  it('names a numbered Cordova group', () => {
    expect(groupOf('2-bugfix/MTX-10838-packaging', 'bugfix/MTX-10838-packaging')).toEqual({
      group: 'Group 2'
    })
    expect(groupOf('3-develop', 'develop')).toEqual({ group: 'Group 3' })
  })

  it('leaves other branches alone, a longer one sharing the prefix too', () => {
    expect(groupOf('1-feature/MTX-1-a', 'feature/MTX-2-b')).toBeNull()
    expect(groupOf('1-feature/MTX-1-a-2', 'feature/MTX-1-a')).toBeNull()
    expect(groupOf('feature/MTX-1-a', 'feature/MTX-1-a')).toBeNull()
  })
})

describe('projectOf', () => {
  it('names the project after the remote repo, so extra checkouts share it', () => {
    const remote = 'git@bitbucket.org:mendrixmobile/mendrix-mobile-next.git'
    expect(projectOf('/dev/mendrix-mobile-next-2', remote)).toBe('mendrix-mobile-next')
    expect(
      projectOf(
        '/dev/mendrix-mobile-next-3',
        `https://bitbucket.org/mendrixmobile/mendrix-mobile-next`
      )
    ).toBe('mendrix-mobile-next')
  })

  it('falls back to the folder name without a remote it can read', () => {
    expect(projectOf('/dev/mendrix-mobile-cordova', null)).toBe('mendrix-mobile-cordova')
    expect(projectOf('/dev/some-repo', 'file:///tmp/x')).toBe('some-repo')
  })
})

describe('runState', () => {
  it('waits, runs, then judges by the counters before the result', () => {
    expect(runState({ status: 'SCHEDULING' })).toBe('queued')
    expect(runState({ status: 'PENDING_DEVICE' })).toBe('queued')
    expect(runState({ status: 'RUNNING' })).toBe('running')
    const done = { status: 'COMPLETED' }
    expect(runState({ ...done, result: 'PASSED', counters: { passed: 3 } })).toBe('passed')
    // Device Farm calls this SKIPPED, but a test failed
    expect(runState({ ...done, result: 'SKIPPED', counters: { passed: 8, failed: 1 } })).toBe(
      'failed'
    )
    expect(runState({ ...done, result: 'SKIPPED', counters: { passed: 6 } })).toBe('passed')
    expect(runState({ ...done, result: 'ERRORED' })).toBe('failed')
    expect(runState({ ...done, result: 'STOPPED' })).toBe('stopped')
  })
})

describe('consoleUrl', () => {
  it('points at the run in the us-west-2 console', () => {
    expect(consoleUrl(`${ARN}abc`)).toBe(
      'https://us-west-2.console.aws.amazon.com/devicefarm/home?region=us-west-2#/mobile/projects/proj-1/runs/run-abc'
    )
  })
})

describe('latestRuns', () => {
  const run = (id: string, name: string, at: number, extra: Partial<DfRun> = {}): DfRun => ({
    arn: `${ARN}${id}`,
    name,
    created: new Date(at),
    status: 'COMPLETED',
    result: 'PASSED',
    completedJobs: 1,
    totalJobs: 1,
    counters: { passed: 3 },
    ...extra
  })

  it('keeps the newest run per group, for this branch only, groups in order', () => {
    const b = 'feature/MTX-1-x'
    const runs = latestRuns(
      [
        run('a', `mmx-next-workingHours-${b} #2 bb`, 2000, { status: 'RUNNING', completedJobs: 0 }),
        run('b', `mmx-next-workingHours-${b} #1 aa`, 1000),
        run('c', `mmx-next-questionnaire-${b} #2 bb`, 2000, { counters: { passed: 2, failed: 1 } }),
        run('d', `mmx-next-workingHours-feature/MTX-9-y #5 cc`, 3000)
      ],
      b
    )
    expect(runs.map((r) => [r.group, r.state, r.build])).toEqual([
      ['questionnaire', 'failed', '#2'],
      ['workingHours', 'running', '#2']
    ])
    expect(runs[0]).toMatchObject({ passed: 2, failed: 1, jobsDone: 1, jobsTotal: 1 })
  })

  it('orders numbered groups by number', () => {
    const runs = latestRuns(
      ['10', '2', '1'].map((n, i) => run(n, `${n}-develop`, i)),
      'develop'
    )
    expect(runs.map((r) => r.group)).toEqual(['Group 1', 'Group 2', 'Group 10'])
  })
})

describe('e2eSummary', () => {
  const g = (state: E2eRun['state'], jobsDone = 1, jobsTotal = 1): E2eRun => ({
    group: state,
    state,
    jobsDone,
    jobsTotal,
    passed: 0,
    failed: 0,
    url: '',
    created: 0
  })

  it('is null without runs', () => {
    expect(e2eSummary([])).toBeNull()
  })

  it('lets a failure win, counts finished groups and job progress', () => {
    expect(e2eSummary([g('failed'), g('running', 0, 1), g('passed')])).toEqual({
      state: 'failed',
      progress: 67,
      done: 2,
      total: 3,
      failedGroups: ['failed']
    })
  })

  it('runs while anything runs, and passes only when all passed', () => {
    expect(e2eSummary([g('passed'), g('queued', 0, 1)])?.state).toBe('queued')
    expect(e2eSummary([g('queued', 0, 1), g('running', 0, 4)])?.state).toBe('running')
    expect(e2eSummary([g('passed'), g('passed')])?.state).toBe('passed')
  })
})
