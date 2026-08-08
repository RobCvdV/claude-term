import type { WindowForecast } from '../shared/types'

/** Linear burn-rate forecast for one rate-limit window. Pure, no I/O. */

export interface RateSample {
  /** epoch seconds the sample was taken */
  t: number
  /** used_percentage at that moment */
  pct: number
  /** epoch seconds the window resets — identifies the window instance */
  resetsAt: number
}

/** Reset timestamps within this many seconds are the same window instance
 *  (payloads occasionally jitter by a second). */
const RESET_TOLERANCE_S = 120
/** Need at least this much observed time before extrapolating. */
const MIN_SPAN_S = 15 * 60
const MIN_SAMPLES = 3
/** Slopes below this (%/s) are "not burning" — ~1% per 3h. */
const MIN_SLOPE = 1 / 10_800

const NONE: WindowForecast = { hitsAt: null, beforeReset: false }

/**
 * Project when the current window hits 100% at the observed pace.
 * Fits only samples of the *current* window instance (a reset chops the
 * series); null when the data is too fresh, too thin, or the pace ≈ 0.
 */
export function forecastWindow(samples: RateSample[], now: number): WindowForecast {
  if (samples.length === 0) return NONE
  const latest = samples[samples.length - 1]
  if (latest.resetsAt <= now) return NONE
  const current = samples.filter(
    (s) => Math.abs(s.resetsAt - latest.resetsAt) <= RESET_TOLERANCE_S && s.t <= now
  )
  if (current.length < MIN_SAMPLES) return NONE
  const span = current[current.length - 1].t - current[0].t
  if (span < MIN_SPAN_S) return NONE

  // least-squares fit of pct over t
  const n = current.length
  let sumT = 0
  let sumP = 0
  for (const s of current) {
    sumT += s.t
    sumP += s.pct
  }
  const meanT = sumT / n
  const meanP = sumP / n
  let num = 0
  let den = 0
  for (const s of current) {
    num += (s.t - meanT) * (s.pct - meanP)
    den += (s.t - meanT) * (s.t - meanT)
  }
  if (den === 0) return NONE
  const slope = num / den
  if (slope < MIN_SLOPE) return NONE

  const intercept = meanP - slope * meanT
  const hitsAt = Math.max(now, (100 - intercept) / slope)
  return { hitsAt: Math.round(hitsAt), beforeReset: hitsAt <= latest.resetsAt }
}
