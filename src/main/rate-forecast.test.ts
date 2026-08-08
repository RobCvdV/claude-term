import { describe, expect, it } from 'vitest'
import { forecastWindow, type RateSample } from './rate-forecast'

const HOUR = 3600
const NOW = 1_700_000_000

// steady climb: pct0 at t0, +ratePerHour every hour
function climb(
  t0: number,
  pct0: number,
  ratePerHour: number,
  steps: number,
  resetsAt: number
): RateSample[] {
  return Array.from({ length: steps }, (_, i) => ({
    t: t0 + i * HOUR,
    pct: pct0 + i * ratePerHour,
    resetsAt
  }))
}

describe('forecastWindow', () => {
  it('projects a steady climb linearly', () => {
    const resetsAt = NOW + 3 * HOUR
    // 20%/h reaching 80% now → 100% in 1h, well before the reset in 3h
    const samples = climb(NOW - 2 * HOUR, 40, 20, 3, resetsAt)
    const f = forecastWindow(samples, NOW)
    expect(f.hitsAt).not.toBeNull()
    expect(f.hitsAt!).toBeCloseTo(NOW + 1 * HOUR, -2)
    expect(f.beforeReset).toBe(true)
  })

  it('reports beforeReset=false when the reset comes first', () => {
    const resetsAt = NOW + 1 * HOUR
    const samples = climb(NOW - 2 * HOUR, 10, 5, 3, resetsAt) // 5%/h → 100% in ~16h
    const f = forecastWindow(samples, NOW)
    expect(f.hitsAt).not.toBeNull()
    expect(f.beforeReset).toBe(false)
  })

  it('returns null for a flat series', () => {
    const resetsAt = NOW + 4 * HOUR
    const samples = climb(NOW - 2 * HOUR, 50, 0, 5, resetsAt)
    expect(forecastWindow(samples, NOW).hitsAt).toBeNull()
  })

  it('ignores samples from the previous window instance', () => {
    const resetsAt = NOW + 4 * HOUR
    const old = climb(NOW - 6 * HOUR, 80, 10, 3, NOW - 1 * HOUR) // pre-reset burn
    const fresh = climb(NOW - 1 * HOUR, 5, 2, 2, resetsAt) // too thin on its own
    expect(forecastWindow([...old, ...fresh], NOW).hitsAt).toBeNull()
  })

  it('returns null when the window is too fresh or too thin', () => {
    const resetsAt = NOW + 4 * HOUR
    const thin = [
      { t: NOW - 300, pct: 10, resetsAt },
      { t: NOW - 150, pct: 12, resetsAt },
      { t: NOW - 10, pct: 14, resetsAt }
    ]
    expect(forecastWindow(thin, NOW).hitsAt).toBeNull()
    expect(forecastWindow([], NOW).hitsAt).toBeNull()
  })

  it('never projects into the past', () => {
    const resetsAt = NOW + 1 * HOUR
    const samples = climb(NOW - 3 * HOUR, 90, 10, 4, resetsAt) // fit crosses 100 before now
    const f = forecastWindow(samples, NOW)
    expect(f.hitsAt).not.toBeNull()
    expect(f.hitsAt!).toBeGreaterThanOrEqual(NOW)
  })
})
