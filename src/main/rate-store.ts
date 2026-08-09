import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import type { RateForecast, StatuslinePayload } from '../shared/types'
import { forecastWindow, type RateSample } from './rate-forecast'

/**
 * Rolling store of rate-limit samples (JSONL in userData). Limits are
 * account-global, so samples come from *every* tab's statusline payload and
 * one series serves the whole app. Pruned to 8 days — enough to cover a full
 * 7-day window instance.
 */

const KEEP_S = 8 * 24 * 3600
/** Identical readings are re-posted by every tab on every keystroke — only
 *  append when the numbers moved or this much time passed. */
const MIN_GAP_S = 300

interface StoredSample {
  t: number
  pct5?: number
  reset5?: number
  pct7?: number
  reset7?: number
}

export class RateStore {
  private samples: StoredSample[] | null = null
  private lastAppended: StoredSample | null = null

  constructor(private readonly file: () => string) {}

  private load(): StoredSample[] {
    if (this.samples) return this.samples
    let lines: string[] = []
    try {
      lines = readFileSync(this.file(), 'utf8').split('\n')
    } catch {
      /* first run — no store yet */
    }
    const now = Date.now() / 1000
    const parsed: StoredSample[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const s = JSON.parse(line) as StoredSample
        if (typeof s.t === 'number' && s.t > now - KEEP_S) parsed.push(s)
      } catch {
        /* skip corrupt line */
      }
    }
    parsed.sort((a, b) => a.t - b.t)
    // rewrite once per run so the file doesn't grow unbounded
    try {
      writeFileSync(this.file(), parsed.map((s) => JSON.stringify(s)).join('\n') + '\n')
    } catch {
      /* best effort */
    }
    this.samples = parsed
    this.lastAppended = parsed[parsed.length - 1] ?? null
    return parsed
  }

  /** Feed one statusline payload; ignored when nothing moved recently. */
  record(payload: StatuslinePayload): void {
    const rl = payload.rate_limits
    if (!rl) return
    const sample: StoredSample = {
      t: Math.round(Date.now() / 1000),
      pct5: rl.five_hour?.used_percentage,
      reset5: rl.five_hour?.resets_at,
      pct7: rl.seven_day?.used_percentage,
      reset7: rl.seven_day?.resets_at
    }
    if (sample.pct5 == null && sample.pct7 == null) return
    const all = this.load()
    const last = this.lastAppended
    if (
      last &&
      sample.t - last.t < MIN_GAP_S &&
      sample.pct5 === last.pct5 &&
      sample.pct7 === last.pct7 &&
      sample.reset5 === last.reset5 &&
      sample.reset7 === last.reset7
    ) {
      return
    }
    all.push(sample)
    this.lastAppended = sample
    try {
      appendFileSync(this.file(), JSON.stringify(sample) + '\n')
    } catch {
      /* best effort */
    }
  }

  forecast(now = Date.now() / 1000): RateForecast {
    const all = this.load()
    const five: RateSample[] = []
    const seven: RateSample[] = []
    for (const s of all) {
      if (s.pct5 != null && s.reset5 != null) five.push({ t: s.t, pct: s.pct5, resetsAt: s.reset5 })
      if (s.pct7 != null && s.reset7 != null)
        seven.push({ t: s.t, pct: s.pct7, resetsAt: s.reset7 })
    }
    return { fiveHour: forecastWindow(five, now), sevenDay: forecastWindow(seven, now) }
  }
}
