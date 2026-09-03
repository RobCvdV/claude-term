import { describe, expect, it } from 'vitest'
import { CODE_LENGTH, CODE_TTL_MS, generateCode, MAX_ATTEMPTS, Pairing } from './pairing'

let now = 1_700_000_000_000
const clock = (): number => now
const fresh = (): Pairing => {
  now = 1_700_000_000_000
  return new Pairing(clock)
}

describe('generateCode', () => {
  it('avoids glyphs that get misread off a screen', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode()
      expect(code).toHaveLength(CODE_LENGTH)
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/)
    }
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()))
    expect(seen.size).toBeGreaterThan(190)
  })
})

describe('Pairing', () => {
  it('has no offer until one is made', () => {
    expect(fresh().current()).toBeNull()
  })

  it('redeems the right code exactly once', () => {
    const pairing = fresh()
    const { code } = pairing.offer()
    expect(pairing.redeem(code)).toBe(true)
    // a second device scanning the same QR gets nothing
    expect(pairing.redeem(code)).toBe(false)
    expect(pairing.current()).toBeNull()
  })

  it('accepts the code however it was typed', () => {
    const pairing = fresh()
    const { code } = pairing.offer()
    expect(pairing.redeem(`  ${code.toLowerCase()} `)).toBe(true)
  })

  it('expires', () => {
    const pairing = fresh()
    const { code } = pairing.offer()
    now += CODE_TTL_MS
    expect(pairing.current()).toBeNull()
    expect(pairing.redeem(code)).toBe(false)
  })

  it('dies after a handful of wrong guesses', () => {
    const pairing = fresh()
    const { code } = pairing.offer()
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(pairing.redeem('WRONGWRO')).toBe(false)
    // the real code is no longer any use — the offer burned down
    expect(pairing.redeem(code)).toBe(false)
    expect(pairing.current()).toBeNull()
  })

  it('replaces the previous offer rather than leaving two valid', () => {
    const pairing = fresh()
    const first = pairing.offer().code
    const second = pairing.offer().code
    expect(pairing.redeem(first)).toBe(false)
    expect(pairing.redeem(second)).toBe(true)
  })

  it('can be cancelled when the pairing screen closes', () => {
    const pairing = fresh()
    const { code } = pairing.offer()
    pairing.cancel()
    expect(pairing.redeem(code)).toBe(false)
  })
})
