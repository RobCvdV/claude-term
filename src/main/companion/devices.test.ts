import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { authPayload, DeviceRegistry, newNonce, secretEquals, verifySignature } from './devices'

const dirs: string[] = []
function registryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-devices-'))
  dirs.push(dir)
  return join(dir, 'companion-devices.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function keypair(): { publicKey: string; signFor: (nonce: string, deviceId: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signFor: (nonce, deviceId) =>
      sign(null, authPayload(nonce, deviceId), privateKey).toString('base64')
  }
}

describe('secretEquals', () => {
  it('compares equal strings', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
  })
  it('rejects differing strings, including different lengths', () => {
    expect(secretEquals('abc', 'abd')).toBe(false)
    expect(secretEquals('abc', 'abcd')).toBe(false)
    expect(secretEquals('', 'a')).toBe(false)
  })
})

describe('verifySignature', () => {
  it('accepts a signature over our nonce', () => {
    const { publicKey, signFor } = keypair()
    const nonce = newNonce()
    expect(verifySignature(publicKey, nonce, 'd1', signFor(nonce, 'd1'))).toBe(true)
  })

  it('rejects a signature over a different nonce — no replay', () => {
    const { publicKey, signFor } = keypair()
    const signature = signFor(newNonce(), 'd1')
    expect(verifySignature(publicKey, newNonce(), 'd1', signature)).toBe(false)
  })

  it('rejects a signature bound to another device id', () => {
    const { publicKey, signFor } = keypair()
    const nonce = newNonce()
    expect(verifySignature(publicKey, nonce, 'd2', signFor(nonce, 'd1'))).toBe(false)
  })

  it('rejects another key holder', () => {
    const nonce = newNonce()
    const mine = keypair()
    const theirs = keypair()
    expect(verifySignature(mine.publicKey, nonce, 'd1', theirs.signFor(nonce, 'd1'))).toBe(false)
  })

  it('rejects garbage instead of throwing', () => {
    const nonce = newNonce()
    expect(verifySignature('not-a-key', nonce, 'd1', 'nope')).toBe(false)
    expect(verifySignature('', nonce, 'd1', '')).toBe(false)
  })

  it('refuses a non-Ed25519 key', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(verifySignature(spki, newNonce(), 'd1', 'sig')).toBe(false)
  })
})

describe('DeviceRegistry', () => {
  it('authenticates a paired device and nobody else', () => {
    const file = registryFile()
    const registry = new DeviceRegistry(() => file)
    const { publicKey, signFor } = keypair()
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey })

    const nonce = newNonce()
    expect(registry.authenticate('d1', nonce, signFor(nonce, 'd1'))?.name).toBe('iPhone')
    expect(registry.authenticate('unknown', nonce, signFor(nonce, 'unknown'))).toBeNull()
  })

  it('stores the registry private to the user', () => {
    const file = registryFile()
    const registry = new DeviceRegistry(() => file)
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey: keypair().publicKey })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('survives a restart', () => {
    const file = registryFile()
    const { publicKey, signFor } = keypair()
    new DeviceRegistry(() => file).add({ deviceId: 'd1', name: 'iPhone', publicKey })

    const reloaded = new DeviceRegistry(() => file)
    const nonce = newNonce()
    expect(reloaded.authenticate('d1', nonce, signFor(nonce, 'd1'))).not.toBeNull()
  })

  it('a revoked device can no longer authenticate', () => {
    const file = registryFile()
    const registry = new DeviceRegistry(() => file)
    const { publicKey, signFor } = keypair()
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey })
    expect(registry.revoke('d1')).toBe(true)

    const nonce = newNonce()
    expect(registry.authenticate('d1', nonce, signFor(nonce, 'd1'))).toBeNull()
    expect(registry.revoke('d1')).toBe(false)
    // and it stays revoked across a restart
    expect(new DeviceRegistry(() => file).get('d1')).toBeNull()
  })

  it('re-pairing replaces the key rather than adding a twin', () => {
    const file = registryFile()
    const registry = new DeviceRegistry(() => file)
    const old = keypair()
    const fresh = keypair()
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey: old.publicKey })
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey: fresh.publicKey })

    expect(registry.list()).toHaveLength(1)
    const nonce = newNonce()
    expect(registry.authenticate('d1', nonce, old.signFor(nonce, 'd1'))).toBeNull()
    expect(registry.authenticate('d1', nonce, fresh.signFor(nonce, 'd1'))).not.toBeNull()
  })

  it('records a push token on connect and keeps it', () => {
    const file = registryFile()
    const registry = new DeviceRegistry(() => file)
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey: keypair().publicKey })
    registry.touch('d1', 'ExponentPushToken[abc]')
    expect(new DeviceRegistry(() => file).get('d1')?.pushToken).toBe('ExponentPushToken[abc]')
  })

  it('ignores a corrupt registry instead of refusing to start', () => {
    const file = registryFile()
    writeFileSync(file, '{ not json')
    expect(new DeviceRegistry(() => file).list()).toEqual([])
  })

  it('skips entries that are missing a key', () => {
    const file = registryFile()
    writeFileSync(file, JSON.stringify({ devices: [{ deviceId: 'd1' }, { name: 'x' }] }))
    expect(new DeviceRegistry(() => file).list()).toEqual([])
  })

  it('never writes a private key', () => {
    const file = registryFile()
    const registry = new DeviceRegistry(() => file)
    registry.add({ deviceId: 'd1', name: 'iPhone', publicKey: keypair().publicKey })
    expect(readFileSync(file, 'utf8')).not.toMatch(/PRIVATE/i)
  })
})
