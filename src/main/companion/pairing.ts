import { randomInt } from 'crypto'
import { secretEquals } from './devices'

/** Long enough to type, short-lived enough that guessing it is pointless. */
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 120_000
/** A code dies after this many wrong guesses, so it can't be brute-forced. */
export const MAX_ATTEMPTS = 5

export interface PairingOffer {
  code: string
  expiresAt: number
}

/** Unambiguous alphabet: no 0/O, 1/I/L, so a code read off a screen can't be mistyped. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

/**
 * A one-shot invitation to pair.
 *
 * Only one is outstanding at a time: opening the pairing screen again replaces
 * the previous code rather than leaving two valid. A code is spent the moment it
 * is accepted, so the same QR can never enrol a second device.
 */
export class Pairing {
  private code: string | null = null
  private expiresAt = 0
  private attempts = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Start (or restart) an offer, invalidating any previous one. */
  offer(): PairingOffer {
    this.code = generateCode()
    this.expiresAt = this.now() + CODE_TTL_MS
    this.attempts = 0
    return { code: this.code, expiresAt: this.expiresAt }
  }

  /** The live offer, or null once it has expired or been spent. */
  current(): PairingOffer | null {
    if (!this.code || this.now() >= this.expiresAt) return null
    return { code: this.code, expiresAt: this.expiresAt }
  }

  cancel(): void {
    this.code = null
    this.expiresAt = 0
    this.attempts = 0
  }

  /** Spend the offer. True only for the right code, once, before it expires. */
  redeem(candidate: string): boolean {
    if (!this.code || this.now() >= this.expiresAt) return false
    if (!secretEquals(this.code.toUpperCase(), candidate.trim().toUpperCase())) {
      if (++this.attempts >= MAX_ATTEMPTS) this.cancel()
      return false
    }
    this.cancel()
    return true
  }
}
