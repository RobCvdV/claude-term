/** How long the Mac stays awake after the last session stopped working. */
export const KEEP_AWAKE_GRACE_MS = 10 * 60_000

export interface PowerBlocker {
  start: () => number
  stop: (id: number) => void
}

/**
 * Holds off system sleep while any Claude session is working, and for a grace
 * period after the last one finishes — long enough to read the answer, or for
 * the next turn to start, without the machine dozing off in between.
 */
export class KeepAwake {
  private id: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly power: PowerBlocker,
    private readonly graceMs = KEEP_AWAKE_GRACE_MS
  ) {}

  get holding(): boolean {
    return this.id !== null
  }

  update(working: boolean): void {
    if (working) {
      this.clearTimer()
      if (this.id === null) this.id = this.power.start()
      return
    }
    if (this.id === null || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.release()
    }, this.graceMs)
  }

  release(): void {
    this.clearTimer()
    if (this.id === null) return
    this.power.stop(this.id)
    this.id = null
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
