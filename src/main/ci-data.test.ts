import { describe, expect, it } from 'vitest'
import {
  actionsCiState,
  actionsJobDone,
  circleCiCiState,
  circleJobDone,
  jenkinsCiState,
  jenkinsProgress,
  jobProgress
} from './ci-data'

describe('jenkinsCiState', () => {
  it('maps building/result to states', () => {
    expect(jenkinsCiState({ building: true, result: null })).toBe('running')
    expect(jenkinsCiState({ building: false, result: 'SUCCESS' })).toBe('success')
    expect(jenkinsCiState({ building: false, result: 'FAILURE' })).toBe('failed')
    expect(jenkinsCiState({ building: false, result: 'UNSTABLE' })).toBe('failed')
    expect(jenkinsCiState({ building: false, result: 'ABORTED' })).toBe('unknown')
    expect(jenkinsCiState({})).toBe('unknown')
  })
})

describe('actionsCiState', () => {
  it('maps the newest run', () => {
    expect(actionsCiState([{ status: 'in_progress', conclusion: null }])).toBe('running')
    expect(actionsCiState([{ status: 'queued', conclusion: null }])).toBe('running')
    expect(actionsCiState([{ status: 'completed', conclusion: 'success' }])).toBe('success')
    expect(actionsCiState([{ status: 'completed', conclusion: 'failure' }])).toBe('failed')
    expect(actionsCiState([{ status: 'completed', conclusion: 'cancelled' }])).toBe('unknown')
    expect(actionsCiState([])).toBe('unknown')
  })
})

describe('circleCiCiState', () => {
  it('aggregates workflow statuses', () => {
    expect(circleCiCiState([{ status: 'running' }, { status: 'success' }])).toBe('running')
    expect(circleCiCiState([{ status: 'on_hold' }, { status: 'success' }])).toBe('held')
    expect(circleCiCiState([{ status: 'on_hold' }, { status: 'failed' }])).toBe('failed')
    expect(circleCiCiState([{ status: 'failed' }, { status: 'success' }])).toBe('failed')
    expect(circleCiCiState([{ status: 'success' }, { status: 'success' }])).toBe('success')
    expect(circleCiCiState([{ status: 'canceled' }])).toBe('unknown')
    expect(circleCiCiState([])).toBe('unknown')
  })
})

describe('build progress', () => {
  it('estimates Jenkins progress from the expected duration, below 100', () => {
    const body = { building: true, timestamp: 1_000, estimatedDuration: 10_000 }
    expect(jenkinsProgress(body, 5_500)).toBe(45)
    expect(jenkinsProgress(body, 60_000)).toBe(99)
    expect(jenkinsProgress({ ...body, building: false }, 5_500)).toBeUndefined()
    expect(jenkinsProgress({ ...body, estimatedDuration: -1 }, 5_500)).toBeUndefined()
  })

  it('counts finished jobs', () => {
    expect(jobProgress(['success', 'running', 'queued', 'failed'], circleJobDone)).toEqual({
      progress: 50,
      detail: '2/4 jobs'
    })
    expect(jobProgress(['completed', 'in_progress', 'queued'], actionsJobDone)).toEqual({
      progress: 33,
      detail: '1/3 jobs'
    })
    expect(jobProgress([], circleJobDone)).toBeUndefined()
  })
})
