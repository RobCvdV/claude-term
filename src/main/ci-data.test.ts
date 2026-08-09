import { describe, expect, it } from 'vitest'
import { actionsCiState, circleCiCiState, jenkinsCiState } from './ci-data'

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
    expect(circleCiCiState([{ status: 'failed' }, { status: 'success' }])).toBe('failed')
    expect(circleCiCiState([{ status: 'success' }, { status: 'success' }])).toBe('success')
    expect(circleCiCiState([{ status: 'canceled' }])).toBe('unknown')
    expect(circleCiCiState([])).toBe('unknown')
  })
})
